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
   * @param {object} options     — { apiKey, model, skipVerify, onStream, onStatus,
   *                                  verificationMode, leanRunner, maxLeanRetries,
   *                                  onStatementReview, taskId }
   * @returns {object} { proof, verdict?, sketch?, leanCode?, leanVerified?, leanLog?,
   *                     sorries?, leanStatement? }
   */
  async prove(texContent, marker, options = {}) {
    console.log(`[Prove] Starting proof for marker "${marker.label || marker.id}" (line ${marker.lineNumber || '?'})`);
    // B-03: bail early if the caller has already aborted
    if (options.signal?.aborted) {
      const err = new Error('Cancelled before start');
      err.code = 'FERMAT_CANCELLED';
      throw err;
    }

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

    let results;
    if (this._hasClaudeCli) {
      results = await this._proveWithClaudeCode(contextPrompt, difficulty, targetNode, options);
    } else {
      results = await this._proveWithDirectApi(contextPrompt, difficulty, targetNode, options);
    }

    // ── Optional Lean verification pass ──────────────────────────────────────
    if (options.verificationMode === 'lean' && options.leanRunner?.isAvailable) {
      results = await this._leanSketchFillVerify(results, contextPrompt, targetNode, options);
    }

    return results;
  }

  // ── Lean sketch → fill → sorrify pipeline ─────────────────────────────────

  /**
   * Three-phase Lean 4 verification pipeline.
   *
   * Phase 1 – Sketch:
   *   Claude generates a proof skeleton with `sorry` for non-trivial steps.
   *   lean type-checks the skeleton; retries up to 2× on structural errors.
   *   ⏸ Statement Review: pauses and waits for user to confirm the theorem statement.
   *
   * Phase 2 – Fill:
   *   For each sorry, Claude fills in the proof; lean verifies each fill.
   *
   * Phase 3 – Sorrify on failure:
   *   Failed fills are retried with error context. If still failing after
   *   maxLeanRetries attempts the sorry is kept (lean-partial result).
   *
   * Status events emitted via options.onStatus:
   *   lean-sketching | lean-sketch-retry | lean-sketch-checking | lean-sketch-ok
   *   lean-statement-review  ← ⏸ waits for options.onStatementReview resolution
   *   lean-filling (sorryIndex/total) | lean-fill-ok | lean-fill-retry | lean-fill-failed
   *   lean-verified | lean-partial | lean-failed
   */
  async _leanSketchFillVerify(results, contextPrompt, targetNode, options) {
    const { onStream, onStatus, leanRunner, apiKey, model } = options;
    const maxSketchRetries = 2;
    const maxFillRetries = options.maxLeanRetries ?? 3;
    const LEAN_SYS = 'You are a Lean 4 proof assistant. Output only valid Lean 4 code in a ```lean4 block.';

    const emitStatus = (phase, extra = {}) => {
      if (onStatus) onStatus({ phase, ...extra });
      console.log(`[LeanSFV] ${phase}`, extra);
    };

    // ── Phase 1: Sketch ────────────────────────────────────────────────────
    let sketch = null;
    let sketchErrors = [];
    let sketchLog = '';

    for (let attempt = 1; attempt <= maxSketchRetries + 1; attempt++) {
      emitStatus(attempt === 1 ? 'lean-sketching' : 'lean-sketch-retry',
        { attempt, maxAttempts: maxSketchRetries + 1 });

      try {
        const raw = await this._callLlm(
          this._buildSketchPrompt(contextPrompt, results.proof, sketch, sketchErrors, attempt),
          onStream, apiKey, model, LEAN_SYS, options.signal,
        );
        sketch = this._extractLeanBlock(raw) || raw.trim();
      } catch (err) {
        console.error('[LeanSFV] Sketch gen failed:', err.message);
        emitStatus('lean-failed', { reason: 'sketch-gen-error' });
        return { ...results, leanCode: null, leanVerified: false, leanLog: '', leanErrors: [], sorries: [] };
      }

      emitStatus('lean-sketch-checking', { attempt });
      sketchLog = '';
      const sketchResult = await leanRunner.verify(sketch, (line) => {
        sketchLog += line + '\n';
        if (onStream) onStream(`[lean] ${line}`);
      }, options.signal);
      sketchErrors = sketchResult.errors.filter(e => e.severity === 'error');

      if (sketchErrors.length === 0) {
        emitStatus('lean-sketch-ok', { attempt });
        // If no sorries at all, the sketch IS the complete proof
        if (!sketch.match(/\bsorry\b/)) {
          emitStatus('lean-verified', {});
          return {
            ...results,
            leanCode: sketch,
            leanVerified: true,
            leanLog: sketchLog.trim(),
            leanErrors: [],
            sorries: [],
            leanStatement: this._parseTheoremStatement(sketch),
          };
        }
        break; // proceed to statement review
      }

      if (attempt > maxSketchRetries) {
        emitStatus('lean-failed', { reason: 'sketch-failed', errorCount: sketchErrors.length });
        return {
          ...results,
          leanCode: sketch,
          leanVerified: false,
          leanLog: sketchLog.trim(),
          leanErrors: sketchErrors,
          sorries: [],
        };
      }
    }

    // ── ⏸ Statement Review ────────────────────────────────────────────────
    // Pause pipeline and let the user confirm (or edit/cancel) the theorem statement.
    const statement = this._parseTheoremStatement(sketch);
    emitStatus('lean-statement-review', { statement, sketch });

    if (options.onStatementReview) {
      const reviewResult = await new Promise((resolve) => {
        options.onStatementReview({ statement, sketch, resolve });
      });

      if (reviewResult.action === 'cancel') {
        emitStatus('lean-failed', { reason: 'user-cancelled' });
        return { ...results, leanCode: sketch, leanVerified: false, leanLog: sketchLog.trim(), leanErrors: [], sorries: [] };
      }

      if (reviewResult.action === 'edit' && reviewResult.newCode) {
        // Re-verify the user-edited sketch before proceeding
        sketch = reviewResult.newCode;
        sketchLog = '';
        const recheck = await leanRunner.verify(sketch, (line) => {
          sketchLog += line + '\n';
          if (onStream) onStream(`[lean] ${line}`);
        }, options.signal);
        sketchErrors = recheck.errors.filter(e => e.severity === 'error');
        if (sketchErrors.length > 0) {
          console.warn('[LeanSFV] User-edited sketch has errors; proceeding anyway per user choice');
        }
      }
      // action === 'confirm': fall through
    }

    // ── Parse sorries ──────────────────────────────────────────────────────
    const sorries = this._parseSorries(sketch);
    console.log(`[LeanSFV] Parsed ${sorries.length} sorries from sketch`);
    const sorryStatuses = sorries.map((s, i) => ({
      ...s, index: i, status: 'pending', fillCode: null, errors: null,
    }));

    let currentCode = sketch;
    let leanLog = sketchLog;

    // ── Phase 2 & 3: Fill each sorry ──────────────────────────────────────
    for (let i = 0; i < sorries.length; i++) {
      // Early exit if all remaining sorries already gone (earlier fill was generous)
      if (!(currentCode.match(/\bsorry\b/g) || []).length) {
        sorryStatuses.slice(i).forEach(s => { s.status = 'filled'; s.fillCode = currentCode; });
        break;
      }

      const sorry = sorryStatuses[i];
      sorry.status = 'filling';
      emitStatus('lean-filling', {
        sorryIndex: i, total: sorries.length,
        filled: sorryStatuses.filter(s => s.status === 'filled').length,
      });

      const prevSorryCount = (currentCode.match(/\bsorry\b/g) || []).length;
      let fillErrors = [];
      let lastCandidate = currentCode;

      for (let attempt = 1; attempt <= maxFillRetries; attempt++) {
        if (attempt > 1) {
          emitStatus('lean-fill-retry', { sorryIndex: i, attempt, maxAttempts: maxFillRetries });
        }

        const prompt = attempt === 1
          ? this._buildFillPrompt(currentCode, sorry, i, sorries.length, results.proof, contextPrompt)
          : this._buildDiagnosePrompt(lastCandidate, sorry, fillErrors, contextPrompt);

        let rawFill;
        try {
          rawFill = await this._callLlm(prompt, onStream, apiKey, model, LEAN_SYS, options.signal);
        } catch (err) {
          console.error(`[LeanSFV] Fill ${i} attempt ${attempt} error:`, err.message);
          break;
        }

        const candidate = this._extractLeanBlock(rawFill) || rawFill.trim();
        lastCandidate = candidate;

        let lineOut = '';
        const fillResult = await leanRunner.verify(candidate, (line) => {
          lineOut += line + '\n';
          if (onStream) onStream(`[lean] ${line}`);
        }, options.signal);
        leanLog = lineOut;
        fillErrors = fillResult.errors.filter(e => e.severity === 'error');

        const newSorryCount = (candidate.match(/\bsorry\b/g) || []).length;
        const madeProgress = newSorryCount < prevSorryCount;

        if (fillErrors.length === 0 && madeProgress) {
          currentCode = candidate;
          sorry.status = 'filled';
          sorry.fillCode = candidate;
          emitStatus('lean-fill-ok', { sorryIndex: i, total: sorries.length });
          break;
        }

        if (!madeProgress) {
          // Claude didn't remove the sorry — synthesise an error to trigger retry
          fillErrors = [
            ...fillErrors,
            { severity: 'error', line: 0, col: 0, message: 'Sorry was not filled — no progress made' },
          ];
        }

        if (attempt >= maxFillRetries) {
          sorry.status = 'failed';
          sorry.errors = fillErrors.filter(e => e.message !== 'Sorry was not filled — no progress made');
          emitStatus('lean-fill-failed', { sorryIndex: i, total: sorries.length });
        }
      }
    }

    // ── Final verdict ──────────────────────────────────────────────────────
    const allFilled  = sorryStatuses.every(s => s.status === 'filled');
    const anyFilled  = sorryStatuses.some(s => s.status === 'filled');
    const remainingSorries = (currentCode.match(/\bsorry\b/g) || []).length;

    let finalLog = '';
    const finalResult = await leanRunner.verify(currentCode, (line) => { finalLog += line + '\n'; }, options.signal);
    const finalErrors = finalResult.errors.filter(e => e.severity === 'error');
    const leanVerified = finalErrors.length === 0 && remainingSorries === 0;

    if (leanVerified)   emitStatus('lean-verified', { sorries: sorryStatuses });
    else if (anyFilled) emitStatus('lean-partial',  { sorries: sorryStatuses });
    else                emitStatus('lean-failed',   { sorries: sorryStatuses });

    return {
      ...results,
      leanCode: currentCode,
      leanVerified,
      leanLog: finalLog.trim(),
      leanErrors: finalErrors,
      sorries: sorryStatuses,
      leanStatement: this._parseTheoremStatement(currentCode),
    };
  }

  /**
   * Unified LLM call — uses Claude CLI when available, direct API otherwise.
   * @param {string} [systemPrompt] — system instructions (prepended for CLI, separate param for API)
   * @param {AbortSignal} [signal]  — forward cancel to the CLI spawn or SDK stream (B-03)
   */
  async _callLlm(prompt, onStream, apiKey, model, systemPrompt = '', signal = undefined) {
    if (signal?.aborted) {
      const err = new Error('Cancelled before LLM call');
      err.code = 'FERMAT_CANCELLED';
      throw err;
    }
    if (this._hasClaudeCli) {
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
      return this._runClaude(fullPrompt, onStream, signal);
    }
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const modelId = model || 'claude-sonnet-4-6';
    let text = '';
    const msgParams = {
      model: modelId,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    };
    if (systemPrompt) msgParams.system = systemPrompt;
    // Anthropic SDK accepts an AbortSignal as the second arg's `signal` option.
    const stream = await client.messages.stream(msgParams, signal ? { signal } : undefined);
    try {
      for await (const ev of stream) {
        if (signal?.aborted) {
          try { stream.controller?.abort?.(); } catch {}
          const err = new Error('Cancelled mid-stream');
          err.code = 'FERMAT_CANCELLED';
          throw err;
        }
        if (ev.type === 'content_block_delta' && ev.delta?.text) {
          text += ev.delta.text;
          if (onStream) onStream(ev.delta.text);
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        const abortErr = new Error('Cancelled');
        abortErr.code = 'FERMAT_CANCELLED';
        throw abortErr;
      }
      throw err;
    }
    return text;
  }

  /** Build the sketch-generation prompt (Phase 1). */
  _buildSketchPrompt(contextPrompt, naturalProof, prevSketch, prevErrors, attempt) {
    if (attempt === 1) {
      return `You are generating a Lean 4 proof skeleton.

RULES:
- Use \`sorry\` as a placeholder for non-trivial proof steps.
- The output MUST type-check with \`sorry\` allowed (no structural or syntax errors).
- Annotate each sorry's expected type with \`show T; sorry\` where possible.
- Do NOT fill in real proofs for sorry placeholders — just build the skeleton.
- Output ONLY a \`\`\`lean4 ... \`\`\` code block, nothing else.

MATHEMATICAL CONTEXT:
${contextPrompt}

INFORMAL PROOF TO FORMALIZE:
${naturalProof}`;
    }

    return `Your previous Lean 4 proof sketch had structural errors. Fix the STRUCTURE only.
Keep all \`sorry\` placeholders as-is — do not fill them in.

Previous sketch:
\`\`\`lean4
${prevSketch}
\`\`\`

Errors to fix:
${prevErrors.map(e => `  line ${e.line}: ${e.message}`).join('\n')}

Output the corrected \`\`\`lean4 ... \`\`\` code block.`;
  }

  /**
   * Parse the positions and context of every `sorry` in the given Lean code.
   * Returns [{ line, col, surroundingCode, expectedType }].
   */
  _parseSorries(code) {
    const lines = code.split('\n');
    const sorries = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/\bsorry\b/.test(lines[i])) continue;
      const col = lines[i].indexOf('sorry');
      // Try to extract annotated expected type from `show T; sorry` or `(sorry : T)`
      const showMatch  = lines[i].match(/\bshow\s+(.+?);\s*sorry\b/);
      const annotMatch = lines[i].match(/\(\s*sorry\s*:\s*([^)]+)\)/);
      const expectedType = (showMatch?.[1] || annotMatch?.[1] || '').trim() || null;
      // ±5 lines context
      const ctxLines = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 3));
      sorries.push({ line: i + 1, col, expectedType, surroundingCode: ctxLines.join('\n') });
    }
    return sorries;
  }

  /** Build the fill prompt for sorry #sorryIndex (Phase 2). */
  _buildFillPrompt(currentCode, sorry, sorryIndex, total, naturalProof, contextPrompt) {
    const typeHint = sorry.expectedType ? `\nExpected type: \`${sorry.expectedType}\`` : '';
    return `Fill in exactly ONE \`sorry\` in the following Lean 4 proof sketch.

SKETCH (filling sorry ${sorryIndex + 1} of ${total}):
\`\`\`lean4
${currentCode}
\`\`\`

The sorry to fill is near line ${sorry.line}:
\`\`\`
${sorry.surroundingCode}
\`\`\`
${typeHint}

INFORMAL PROOF CONTEXT:
${naturalProof}

${contextPrompt.slice(0, 800)}

OUTPUT: The complete Lean 4 code with sorry #${sorryIndex + 1} replaced by a working proof.
Keep all OTHER \`sorry\` placeholders unchanged.
Output ONLY a \`\`\`lean4 ... \`\`\` code block.`;
  }

  /** Build the diagnose/retry prompt for a failed fill (Phase 3). */
  _buildDiagnosePrompt(code, sorry, errors, contextPrompt) {
    return `The following Lean 4 proof attempt failed. Fix the errors.

CURRENT CODE:
\`\`\`lean4
${code}
\`\`\`

LEAN ERRORS:
${errors.map(e => `  line ${e.line}: ${e.message}`).join('\n')}

TARGET SUBGOAL (near line ${sorry.line}):
\`\`\`
${sorry.surroundingCode}
\`\`\`

${contextPrompt.slice(0, 600)}

Output the COMPLETE corrected \`\`\`lean4 ... \`\`\` code block.
Keep unrelated \`sorry\` placeholders unchanged.`;
  }

  /**
   * Extract the theorem/lemma declaration header from Lean 4 code.
   * Returns the part before `:= by` or `:=`.
   */
  _parseTheoremStatement(code) {
    if (!code) return null;
    const assignIdx = code.search(/:=\s*(by\b|\{)/);
    if (assignIdx >= 0) return code.slice(0, assignIdx).trim();
    // Fallback: first meaningful lines (skip imports/opens/comments)
    const lines = code.split('\n').filter(l => l.trim() && !l.startsWith('import') && !l.startsWith('open') && !l.startsWith('--') && !l.startsWith('/-'));
    return lines.slice(0, 5).join('\n');
  }

  /**
   * Extract the first ```lean4 ... ``` (or ```lean ...) block from a string.
   * Falls back to the full string if no fence is found.
   */
  _extractLeanBlock(text) {
    if (!text) return '';
    const m = text.match(/```(?:lean4?)\n([\s\S]*?)```/);
    if (m) return m[1].trim();
    // Sometimes the model outputs a plain ``` block
    const m2 = text.match(/```\n([\s\S]*?)```/);
    if (m2) return m2[1].trim();
    return text.trim();
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
      results.sketch = await this._runClaude(sketchPrompt, onStream, options.signal);
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
    results.proof = await this._runClaude(provePrompt, onStream, options.signal);
    console.log(`[Prove] Proof draft done (${Date.now()-tp0}ms, ${results.proof.length}ch)`);

    // Verify (unless skipped)
    if (!options.skipVerify) {
      console.log(`[Prove] Phase 3/3: verify (fermat-verify skill)`);
      const verifySkill = this._loadSkill('fermat-verify');
      const verifyPrompt = `${verifySkill}\n\n---\n\n${contextPrompt}\n\n<proof_to_verify>\n${results.proof}\n</proof_to_verify>`;
      const tv0 = Date.now();
      results.verdict = await this._runClaude(verifyPrompt, onStream, options.signal);
      const verdictTag = results.verdict.match(/<verdict>(\w+)/)?.[1] || 'unknown';
      console.log(`[Prove] Verdict: ${verdictTag} (${Date.now()-tv0}ms)`);

      // If verification fails, attempt one self-correction
      const needsRetry = results.verdict &&
        (results.verdict.includes('<verdict>FAIL') || results.verdict.includes('<verdict>NEEDS_REVISION'));
      if (needsRetry) {
        console.log(`[Prove] Verification failed — retrying with feedback`);
        const retryPrompt = `${proveSkill}\n\n---\n\n${contextPrompt}\n\n<previous_attempt>\n${results.proof}\n</previous_attempt>\n\n<verification_feedback>\n${results.verdict}\n</verification_feedback>\n\nThe previous proof attempt FAILED verification. Please write a corrected proof addressing the issues identified above.`;
        results.proof = await this._runClaude(retryPrompt, onStream, options.signal);

        // Re-verify
        const reVerifyPrompt = `${verifySkill}\n\n---\n\n${contextPrompt}\n\n<proof_to_verify>\n${results.proof}\n</proof_to_verify>`;
        results.verdict = await this._runClaude(reVerifyPrompt, onStream, options.signal);
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
   * @param {AbortSignal} [signal] — kill the child process on abort (B-03)
   */
  _runClaude(prompt, onStream, signal = undefined) {
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
      let abortedByCaller = false;

      const onAbort = () => {
        abortedByCaller = true;
        try { proc.kill('SIGTERM'); } catch {}
        // Force-kill if it doesn't exit promptly
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        if (onStream) onStream(text);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // B-06: surface stdin EPIPE instead of letting it bubble as an
      // uncaught exception on the main process (happens when the child
      // exits before consuming the full prompt — long prompts, early crash).
      proc.stdin.on('error', (err) => {
        if (err.code === 'EPIPE') {
          console.warn(`[ClaudeCLI] stdin EPIPE — child exited before reading full prompt`);
        } else {
          console.warn(`[ClaudeCLI] stdin error: ${err.message}`);
        }
      });
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch (err) {
        // If the child has already exited, write throws synchronously —
        // fall through; the 'close' handler will deliver the real error.
        console.warn(`[ClaudeCLI] stdin.write threw: ${err.message}`);
      }

      proc.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (abortedByCaller) {
          const abortErr = new Error('Cancelled');
          abortErr.code = 'FERMAT_CANCELLED';
          return reject(abortErr);
        }
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
        if (signal) signal.removeEventListener('abort', onAbort);
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

    // Helper: run a single API call with a system prompt and user prompt.
    // B-03: honour options.signal — abort mid-stream if the caller cancels.
    const runApi = async (systemPrompt, userPrompt, phaseLabel = 'call') => {
      if (options.signal?.aborted) {
        const err = new Error('Cancelled before API call');
        err.code = 'FERMAT_CANCELLED';
        throw err;
      }
      const t0 = Date.now();
      let fullText = '';
      try {
        const stream = await client.messages.stream(
          {
            model: modelId,
            max_tokens: 8192,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          },
          options.signal ? { signal: options.signal } : undefined,
        );
        for await (const event of stream) {
          if (options.signal?.aborted) {
            try { stream.controller?.abort?.(); } catch {}
            const err = new Error('Cancelled mid-stream');
            err.code = 'FERMAT_CANCELLED';
            throw err;
          }
          if (event.type === 'content_block_delta' && event.delta?.text) {
            fullText += event.delta.text;
            if (onStream) onStream(event.delta.text);
          }
        }
        console.log(`[DirectAPI] ${phaseLabel} done (${Date.now()-t0}ms, ${fullText.length}ch)`);
        return fullText;
      } catch (err) {
        if (options.signal?.aborted) {
          const abortErr = new Error('Cancelled');
          abortErr.code = 'FERMAT_CANCELLED';
          throw abortErr;
        }
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
