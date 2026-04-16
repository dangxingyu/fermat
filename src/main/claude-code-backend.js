const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ContextAssembler } = require('./context-assembler');
const { parseTheoryOutline } = require('./outline-parser');

/**
 * Classify an API/network error into a structured { code, userMessage } pair
 * so the renderer can show a helpful, actionable toast instead of a raw stack.
 *
 * Attaches `.fermatCode` and `.fermatUserMessage` to the error in place so
 * copilot-engine.js can forward them without knowing about API internals.
 */
function classifyAndAnnotateError(err) {
  const status = err.status || err.statusCode;
  const msg = (err.message || '').toLowerCase();

  let code, userMessage;

  if (status === 401 || msg.includes('invalid x-api-key') || msg.includes('authentication')) {
    code = 'AUTH_ERROR';
    userMessage = 'Invalid API key. Open Settings and check your Anthropic key.';
  } else if (status === 402 || msg.includes('credit') || msg.includes('billing') || msg.includes('quota')) {
    code = 'QUOTA_EXCEEDED';
    userMessage = 'Anthropic account quota exceeded. Check your billing at console.anthropic.com.';
  } else if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
    code = 'RATE_LIMIT';
    userMessage = 'Rate limit hit. Wait a moment, then try again.';
  } else if (status === 500 || status === 502 || status === 503 || status === 529) {
    code = 'API_UNAVAILABLE';
    userMessage = 'Anthropic API is temporarily unavailable. Try again in a minute.';
  } else if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('network') || msg.includes('fetch failed')) {
    code = 'NETWORK_ERROR';
    userMessage = 'Network error — check your internet connection.';
  } else if (msg.includes('api key') || msg.includes('no api key') || msg.includes('not configured')) {
    code = 'NO_API_KEY';
    userMessage = 'No API key configured. Open Settings and add your Anthropic key.';
  } else {
    code = 'UNKNOWN_ERROR';
    userMessage = `Proof failed: ${err.message}`;
  }

  err.fermatCode = code;
  err.fermatUserMessage = userMessage;
  return err;
}

/**
 * ClaudeCodeBackend
 *
 * Uses Claude Code (the CLI agent) as the proving backend for Fermat.
 *
 * Instead of calling the Anthropic/Google API directly, we:
 *   1. Parse the document into structured context
 *   2. Write a task file with the context + skill reference
 *   3. Invoke `claude` CLI in non-interactive mode
 *   4. Parse the output to extract the proof
 *
 * This gives us:
 *   - Skills system for different proof strategies
 *   - Agent-level reasoning (the model can read files, think step by step)
 *   - Tool use (model can invoke Lean/Coq checkers if available)
 *   - Natural extension to multi-step proving workflows
 *
 * Falls back to direct API calls if Claude Code CLI is not available.
 */
class ClaudeCodeBackend {
  constructor() {
    this.contextAssembler = new ContextAssembler();
    // Project root — where .claude/skills/ lives.
    // In packaged builds, electron-builder copies .claude/skills into
    // Contents/Resources/.claude/skills via the build.extraResources config,
    // and __dirname points inside app.asar (read-only, wrong place to cd into).
    // In dev we use the repo root so claude CLI auto-discovers the real skills.
    const { app } = require('electron');
    if (app && app.isPackaged) {
      this.projectRoot = process.resourcesPath;
    } else {
      this.projectRoot = path.join(__dirname, '../..');
    }
    this.skillsDir = path.join(this.projectRoot, '.claude/skills');
    this._claudePath = null;
    this._hasClaudeCli = false;
    this._detectCli();

    // Working directory for task files (temp prompts etc.)
    this.workDir = path.join(os.tmpdir(), 'fermat-proving');
    if (!fs.existsSync(this.workDir)) {
      fs.mkdirSync(this.workDir, { recursive: true });
    }
  }

  _detectCli() {
    const { execFileSync } = require('child_process');
    try {
      const result = execFileSync('which', ['claude'], {
        timeout: 3000,
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin',
        },
      });
      this._claudePath = result.toString().trim();
      this._hasClaudeCli = true;
      console.log(`[ClaudeCodeBackend] CLI found: ${this._claudePath}`);
    } catch {
      this._hasClaudeCli = false;
      console.log('[ClaudeCodeBackend] Claude CLI not found — will use direct API fallback');
    }
  }

  get isAvailable() {
    return this._hasClaudeCli;
  }

  /**
   * Execute a proving workflow for a given marker.
   *
   * @param {string} texContent  — full document content
   * @param {object} marker      — { id, difficulty, label, lineNumber, ... }
   * @param {object} options     — { apiKey, model, skipVerify, onStream }
   * @returns {object} { proof, verdict?, sketch? }
   */
  async prove(texContent, marker, options = {}) {
    console.log(`[Prove] Starting proof for marker "${marker.label || marker.id}" (line ${marker.lineNumber || '?'})`);

    // 1. Parse the document
    const outline = parseTheoryOutline(texContent);

    // 2. Find the target node
    const targetNode = this._findTargetNode(outline, marker);
    if (!targetNode) {
      throw new Error(`Could not find theorem/lemma for marker: ${marker.label}`);
    }

    // 3. Assemble context
    const ctx = this.contextAssembler.assembleForProof(outline, targetNode);
    const contextPrompt = this.contextAssembler.formatAsPrompt(ctx);

    // 4. Choose workflow based on difficulty
    const difficulty = targetNode.proveItMarker?.difficulty || 'Medium';
    const path = this._hasClaudeCli ? 'Claude CLI' : 'direct API';
    console.log(`[Prove] Target: ${targetNode.type} "${targetNode.name || targetNode.labels?.[0]}" | difficulty=${difficulty} | path=${path} | context=${contextPrompt.length}ch | deps=${ctx.directDependencies.length}`);

    if (this._hasClaudeCli) {
      return this._proveWithClaudeCode(contextPrompt, difficulty, targetNode, options);
    } else {
      return this._proveWithDirectApi(contextPrompt, difficulty, targetNode, options);
    }
  }

  /**
   * Prove using Claude Code CLI with skills.
   */
  async _proveWithClaudeCode(contextPrompt, difficulty, targetNode, options) {
    const { onStream } = options;
    const results = {};

    // For Medium/Hard: always run fermat-sketch.
    //   - No user sketch:   sketch from scratch
    //   - With user sketch: elaborate it (user sketches are often vague or
    //                        partial; sketch skill fills in details, surfaces
    //                        hidden prerequisites, and extends to uncovered
    //                        sub-claims).
    // The user sketch is already embedded in contextPrompt via <user_sketch>.
    if (difficulty !== 'Easy') {
      console.log(`[Prove] Phase 1/3: sketch (fermat-sketch skill)`);
      const sketchSkill = this._loadSkill('fermat-sketch');
      const sketchPrompt = `${sketchSkill}\n\n---\n\nHere is the context for your task:\n\n${contextPrompt}`;
      const t0 = Date.now();
      results.sketch = await this._runClaude(sketchPrompt, onStream);
      console.log(`[Prove] Sketch done (${Date.now()-t0}ms, ${results.sketch.length}ch)`);
    }

    // Run the prove skill
    console.log(`[Prove] Phase ${difficulty === 'Easy' ? '1/1' : '2/3'}: prove (fermat-prove skill)`);
    const proveSkill = this._loadSkill('fermat-prove');
    let provePrompt = `${proveSkill}\n\n---\n\nHere is the context for your task:\n\n${contextPrompt}`;
    if (results.sketch) {
      provePrompt += `\n\n<proof_sketch>\n${results.sketch}\n</proof_sketch>`;
    }
    const tp0 = Date.now();
    results.proof = await this._runClaude(provePrompt, onStream);
    console.log(`[Prove] Proof draft done (${Date.now()-tp0}ms, ${results.proof.length}ch)`);

    // Verify (unless skipped)
    if (!options.skipVerify) {
      console.log(`[Prove] Phase 3/3: verify (fermat-verify skill)`);
      const verifySkill = this._loadSkill('fermat-verify');
      const verifyPrompt = `${verifySkill}\n\n---\n\n${contextPrompt}\n\n<proof_to_verify>\n${results.proof}\n</proof_to_verify>`;
      const tv0 = Date.now();
      results.verdict = await this._runClaude(verifyPrompt, onStream);
      const verdictTag = results.verdict.match(/<verdict>(\w+)/)?.[1] || 'unknown';
      console.log(`[Prove] Verdict: ${verdictTag} (${Date.now()-tv0}ms)`);

      // If verification fails, attempt one self-correction
      const needsRetry = results.verdict &&
        (results.verdict.includes('<verdict>FAIL') || results.verdict.includes('<verdict>NEEDS_REVISION'));
      if (needsRetry) {
        console.log(`[Prove] Verification failed — retrying with feedback`);
        const retryPrompt = `${proveSkill}\n\n---\n\n${contextPrompt}\n\n<previous_attempt>\n${results.proof}\n</previous_attempt>\n\n<verification_feedback>\n${results.verdict}\n</verification_feedback>\n\nThe previous proof attempt FAILED verification. Please write a corrected proof addressing the issues identified above.`;
        results.proof = await this._runClaude(retryPrompt, onStream);

        // Re-verify
        const reVerifyPrompt = `${verifySkill}\n\n---\n\n${contextPrompt}\n\n<proof_to_verify>\n${results.proof}\n</proof_to_verify>`;
        results.verdict = await this._runClaude(reVerifyPrompt, onStream);
        const reVerdictTag = results.verdict.match(/<verdict>(\w+)/)?.[1] || 'unknown';
        console.log(`[Prove] Re-verify verdict: ${reVerdictTag}`);
      }
    } else {
      console.log(`[Prove] Verification skipped (Easy difficulty or skipVerify=true)`);
    }

    // Extract just the \begin{proof}...\end{proof} from the output
    results.proof = this._extractProof(results.proof);

    return results;
  }

  /**
   * Run claude CLI in non-interactive (print) mode.
   */
  _runClaude(prompt, onStream) {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',              // non-interactive, just output the result
        '--model', 'claude-sonnet-4-6',
      ];

      // Always pipe prompt via stdin (works for any prompt length)
      const proc = spawn(this._claudePath, args, {
        cwd: this.projectRoot,  // Claude Code auto-discovers .claude/skills/ from here
        env: {
          ...process.env,
          PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        if (onStream) onStream(text);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.stdin.write(prompt);
      proc.stdin.end();

      proc.on('close', (code) => {
        if (code !== 0 && !stdout) {
          console.error(`[ClaudeCLI] Exit ${code}: ${stderr.slice(0, 400)}`);
          const err = new Error(`Claude CLI exited with code ${code}: ${stderr}`);
          reject(classifyAndAnnotateError(err));
        } else {
          if (stderr) console.warn(`[ClaudeCLI] stderr: ${stderr.slice(0, 200)}`);
          resolve(stdout.trim());
        }
      });

      proc.on('error', (err) => {
        console.error(`[ClaudeCLI] Spawn failed: ${err.message}`);
        const wrapped = new Error(`Failed to spawn Claude CLI: ${err.message}`);
        reject(classifyAndAnnotateError(wrapped));
      });
    });
  }

  /**
   * Direct API fallback when Claude Code CLI is not available.
   * Uses the same context assembly but calls the API directly.
   */
  async _proveWithDirectApi(contextPrompt, difficulty, targetNode, options) {
    const { apiKey, model, onStream } = options;
    if (!apiKey) {
      const err = new Error('No API key configured and Claude Code CLI not available.');
      throw classifyAndAnnotateError(err);
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const modelId = model || 'claude-sonnet-4-6';
    console.log(`[DirectAPI] Using model ${modelId}`);
    const results = {};

    // Helper: run a single API call with a system prompt and user prompt
    const runApi = async (systemPrompt, userPrompt, phaseLabel = 'call') => {
      const t0 = Date.now();
      let fullText = '';
      try {
        const stream = await client.messages.stream({
          model: modelId,
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        });
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta?.text) {
            fullText += event.delta.text;
            if (onStream) onStream(event.delta.text);
          }
        }
        console.log(`[DirectAPI] ${phaseLabel} done (${Date.now()-t0}ms, ${fullText.length}ch)`);
        return fullText;
      } catch (err) {
        console.error(`[DirectAPI] ${phaseLabel} failed: ${err.message}`);
        throw classifyAndAnnotateError(err);
      }
    };

    // For Medium/Hard: always run fermat-sketch.
    // (See _proveWithClaudeCode for the rationale — user sketches may be vague
    // or partial, so we always run the sketch skill to elaborate them.)
    if (difficulty !== 'Easy') {
      console.log(`[Prove] Phase 1/3: sketch (fermat-sketch skill)`);
      const sketchSkill = this._loadSkill('fermat-sketch');
      results.sketch = await runApi(sketchSkill, contextPrompt, 'sketch');
    }

    // Run the prove skill
    console.log(`[Prove] Phase ${difficulty === 'Easy' ? '1/1' : '2/3'}: prove (fermat-prove skill)`);
    const proveSkill = this._loadSkill('fermat-prove');
    let proveInput = contextPrompt;
    if (results.sketch) {
      proveInput += `\n\n<proof_sketch>\n${results.sketch}\n</proof_sketch>`;
    }
    let proofOutput = await runApi(proveSkill, proveInput, 'prove');

    // Verify (unless skipped)
    if (!options.skipVerify) {
      console.log(`[Prove] Phase 3/3: verify (fermat-verify skill)`);
      const verifySkill = this._loadSkill('fermat-verify');
      const verifyInput = `${contextPrompt}\n\n<proof_to_verify>\n${proofOutput}\n</proof_to_verify>`;
      results.verdict = await runApi(verifySkill, verifyInput, 'verify');
      const verdictTag = results.verdict.match(/<verdict>(\w+)/)?.[1] || 'unknown';
      console.log(`[Prove] Verdict: ${verdictTag}`);

      // If verification fails, attempt one self-correction
      const needsRetry = results.verdict &&
        (results.verdict.includes('<verdict>FAIL') || results.verdict.includes('<verdict>NEEDS_REVISION'));
      if (needsRetry) {
        console.log(`[Prove] Verification failed — retrying with feedback`);
        const retryInput = `${contextPrompt}\n\n<previous_attempt>\n${proofOutput}\n</previous_attempt>\n\n<verification_feedback>\n${results.verdict}\n</verification_feedback>\n\nThe previous proof attempt FAILED verification. Please write a corrected proof addressing the issues identified above.`;
        proofOutput = await runApi(proveSkill, retryInput, 'prove-retry');

        // Re-verify
        const reVerifyInput = `${contextPrompt}\n\n<proof_to_verify>\n${proofOutput}\n</proof_to_verify>`;
        results.verdict = await runApi(verifySkill, reVerifyInput, 'verify-retry');
        const reVerdictTag = results.verdict.match(/<verdict>(\w+)/)?.[1] || 'unknown';
        console.log(`[Prove] Re-verify verdict: ${reVerdictTag}`);
      }
    } else {
      console.log(`[Prove] Verification skipped`);
    }

    results.proof = proofOutput;

    return {
      proof: this._extractProof(results.proof),
      sketch: results.sketch || null,
      verdict: results.verdict || null,
    };
  }

  /**
   * Load a skill's SKILL.md content, stripping frontmatter.
   * @param {string} name — skill directory name (e.g. 'fermat-prove')
   */
  _loadSkill(name) {
    const skillPath = path.join(this.skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Skill not found: ${skillPath}`);
    }
    return fs.readFileSync(skillPath, 'utf-8').replace(/^---[\s\S]*?---\n*/, '');
  }

  /**
   * Find the outline node matching a marker.
   */
  _findTargetNode(outline, marker) {
    // Try by lineNumber first
    if (marker.lineNumber) {
      return outline.nodes.find(n =>
        n.proveItMarker &&
        Math.abs(n.lineNumber - marker.lineNumber) < 10
      );
    }
    // Try by id
    if (marker.id) {
      return outline.nodes.find(n => n.id === marker.id);
    }
    // Try by label
    if (marker.label) {
      return outline.nodes.find(n =>
        n.labels?.some(l => marker.label.includes(l)) ||
        marker.label.includes(n.name)
      );
    }
    return null;
  }

  /**
   * Extract \begin{proof}...\end{proof} from model output.
   * Falls back to the full output if no proof environment is found.
   */
  _extractProof(text) {
    if (!text) return '';
    const match = text.match(/\\begin\{proof\}[\s\S]*?\\end\{proof\}/);
    if (match) return match[0];
    // If output doesn't have proof env, wrap it
    const trimmed = text.trim();
    if (!trimmed.startsWith('\\begin{proof}')) {
      return `\\begin{proof}\n${trimmed}\n\\end{proof}`;
    }
    return trimmed;
  }

  /**
   * Record an accepted proof in the context assembler's memory.
   */
  recordAcceptedProof(label, statementTeX, proofTeX) {
    this.contextAssembler.recordAcceptedProof(label, statementTeX, proofTeX);
  }
}

module.exports = { ClaudeCodeBackend };
