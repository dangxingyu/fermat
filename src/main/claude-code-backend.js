const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ContextAssembler } = require('./context-assembler');
const { parseTheoryOutline } = require('./outline-parser');
const { ClaudeProvider, resolveModelId } = require('./llm-provider');

/**
 * Classify an API/network error into a structured { code, userMessage } pair
 * so the renderer can show a helpful, actionable toast instead of a raw stack.
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
 * Falls back to direct API via ClaudeProvider when the CLI is not available.
 */
class ClaudeCodeBackend {
  constructor() {
    this.contextAssembler = new ContextAssembler();

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

    this.workDir = path.join(os.tmpdir(), 'fermat-proving');
    if (!fs.existsSync(this.workDir)) {
      fs.mkdirSync(this.workDir, { recursive: true });
    }

    // Provider abstraction for direct API calls (CLI path bypasses this)
    this._provider = null;

    // Session-scoped verify cache: source-hash → LeanRunner.verify() result
    this._verifyCache = new Map();
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
   * Get or (re)create the ClaudeProvider for a given apiKey + model pair.
   * Called on every direct-API _callLlm invocation; cheap if nothing changed.
   */
  _getOrUpdateProvider(apiKey, model) {
    const modelId = resolveModelId(model);
    if (!this._provider || this._provider.apiKey !== apiKey || this._provider.model !== modelId) {
      this._provider = new ClaudeProvider({ apiKey, model: modelId });
    }
    return this._provider;
  }

  /**
   * Execute a proving workflow for a given marker.
   *
   * @param {string} texContent  — full document content
   * @param {object} marker      — { id, difficulty, label, lineNumber, ... }
   * @param {object} options     — { apiKey, model, skipVerify, onStream, onStatus,
   *                                  verificationMode, leanRunner, maxLeanRetries,
   *                                  onStatementReview, taskId, signal }
   * @returns {object} { proof, verdict?, sketch?, leanCode?, leanVerified?, leanLog?,
   *                     sorries?, leanStatement? }
   */
  async prove(texContent, marker, options = {}) {
    console.log(`[Prove] Starting proof for marker "${marker.label || marker.id}" (line ${marker.lineNumber || '?'})`);
    if (options.signal?.aborted) {
      const err = new Error('Cancelled before start');
      err.code = 'FERMAT_CANCELLED';
      throw err;
    }

    const outline = parseTheoryOutline(texContent);
    const targetNode = this._findTargetNode(outline, marker);
    if (!targetNode) {
      throw new Error(`Could not find theorem/lemma for marker: ${marker.label}`);
    }

    const ctx = this.contextAssembler.assembleForProof(outline, targetNode);
    const contextPrompt = this.contextAssembler.formatAsPrompt(ctx);

    const difficulty = targetNode.proveItMarker?.difficulty || 'Medium';
    const whichPath = this._hasClaudeCli ? 'Claude CLI' : 'direct API';
    console.log(`[Prove] Target: ${targetNode.type} "${targetNode.name || targetNode.labels?.[0]}" | difficulty=${difficulty} | path=${whichPath} | context=${contextPrompt.length}ch | deps=${ctx.directDependencies.length}`);

    if (!this._hasClaudeCli && !options.apiKey) {
      const err = new Error('No API key configured and Claude Code CLI not available.');
      throw classifyAndAnnotateError(err);
    }
    let results = await this._proveThreePhase(contextPrompt, difficulty, targetNode, options);

    if (options.verificationMode === 'lean' && options.leanRunner?.isAvailable) {
      results = await this._leanSketchFillVerify(results, contextPrompt, targetNode, options);
    }

    return results;
  }

  /**
   * Unified three-phase LaTeX prove pipeline (Q-01).
   * Phases: Sketch (Medium/Hard) → Prove → Verify + 1 self-correction.
   */
  async _proveThreePhase(contextPrompt, difficulty, targetNode, options) {
    const { onStream, apiKey, model, signal } = options;
    const results = {};

    if (difficulty !== 'Easy') {
      console.log('[Prove] Phase 1/3: sketch (fermat-sketch skill)');
      const sketchSkill = this._loadSkill('fermat-sketch');
      const t0 = Date.now();
      results.sketch = await this._callLlm(contextPrompt, onStream, apiKey, model, sketchSkill, signal);
      console.log(`[Prove] Sketch done (${Date.now() - t0}ms, ${results.sketch.length}ch)`);
    }

    console.log(`[Prove] Phase ${difficulty === 'Easy' ? '1/1' : '2/3'}: prove (fermat-prove skill)`);
    const proveSkill = this._loadSkill('fermat-prove');
    let proveInput = contextPrompt;
    if (results.sketch) {
      proveInput += `\n\n<proof_sketch>\n${results.sketch}\n</proof_sketch>`;
    }
    const tp0 = Date.now();
    let proofOutput = await this._callLlm(proveInput, onStream, apiKey, model, proveSkill, signal);
    console.log(`[Prove] Proof draft done (${Date.now() - tp0}ms, ${proofOutput.length}ch)`);

    if (!options.skipVerify) {
      console.log('[Prove] Phase 3/3: verify (fermat-verify skill)');
      const verifySkill = this._loadSkill('fermat-verify');
      const verifyInput = `${contextPrompt}\n\n<proof_to_verify>\n${proofOutput}\n</proof_to_verify>`;
      const tv0 = Date.now();
      results.verdict = await this._callLlm(verifyInput, onStream, apiKey, model, verifySkill, signal);
      const verdictTag = results.verdict.match(/<verdict>(\w+)/)?.[1] || 'unknown';
      console.log(`[Prove] Verdict: ${verdictTag} (${Date.now() - tv0}ms)`);

      const needsRetry = results.verdict &&
        (results.verdict.includes('<verdict>FAIL') || results.verdict.includes('<verdict>NEEDS_REVISION'));
      if (needsRetry) {
        console.log('[Prove] Verification failed — retrying with feedback');
        const retryInput =
          `${contextPrompt}\n\n<previous_attempt>\n${proofOutput}\n</previous_attempt>\n\n` +
          `<verification_feedback>\n${results.verdict}\n</verification_feedback>\n\n` +
          `The previous proof attempt FAILED verification. Please write a corrected proof addressing the issues identified above.`;
        proofOutput = await this._callLlm(retryInput, onStream, apiKey, model, proveSkill, signal);

        const reVerifyInput = `${contextPrompt}\n\n<proof_to_verify>\n${proofOutput}\n</proof_to_verify>`;
        results.verdict = await this._callLlm(reVerifyInput, onStream, apiKey, model, verifySkill, signal);
        console.log(`[Prove] Re-verify verdict: ${results.verdict.match(/<verdict>(\w+)/)?.[1] || 'unknown'}`);
      }
    } else {
      console.log('[Prove] Verification skipped');
    }

    results.proof = this._extractProof(proofOutput);
    return results;
  }

  // ── Lean sketch → fill → sorrify pipeline ─────────────────────────────────

  /**
   * Three-phase Lean 4 verification pipeline.
   *
   * Phase 1 – Sketch:  Claude generates a sorry-skeleton; lean type-checks it.
   * ⏸ Statement Review: user confirms the theorem statement.
   * Phase 2 – Fill: for each sorry, Claude fills in the proof; lean verifies.
   * Phase 3 – Final verdict.
   *
   * Optimisations vs. original:
   *   - Rich Lean 4 system prompt (tactic guidance, Lean 3 pitfall guards)
   *   - Few-shot examples in sketch / fill / diagnose prompts
   *   - trace_state goal-state probe after sketch verifies
   *   - Context-region-aware sorry parser with enclosing-declaration context
   *   - Lean verify result cache (avoids re-running lean on identical source)
   *   - Full contextPrompt in fill/diagnose (not truncated to 800/600 chars)
   */
  async _leanSketchFillVerify(results, contextPrompt, targetNode, options) {
    const { onStream, onStatus, leanRunner, apiKey, model } = options;
    const maxSketchRetries = 2;
    const maxFillRetries = options.maxLeanRetries ?? 3;

    // Build rich Lean 4 system prompt (aware of mathlib availability)
    const usesMathlib = leanRunner.mathlibReady;
    const LEAN_SYS = this._buildLeanSys(usesMathlib);

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
      const sketchResult = await this._cachedVerify(leanRunner, sketch, (line) => {
        sketchLog += line + '\n';
        if (onStream) onStream(`[lean] ${line}`);
      }, options.signal);
      sketchErrors = sketchResult.errors.filter(e => e.severity === 'error');

      if (sketchErrors.length === 0) {
        emitStatus('lean-sketch-ok', { attempt });
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
        break;
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

    // ── Goal-state probe ────────────────────────────────────────────────────
    // After the sketch type-checks, run a trace_state probe to extract
    // Lean-elaborated goal states for bare (unannotated) sorries. This
    // enriches sorry.expectedType and sorry.hypotheses before the fill phase.
    const sorries = await this._probeGoalStates(sketch, leanRunner, options.signal);
    console.log(`[LeanSFV] Parsed ${sorries.length} sorries from sketch`);

    // ── ⏸ Statement Review ────────────────────────────────────────────────
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
        sketch = reviewResult.newCode;
        sketchLog = '';
        const recheck = await this._cachedVerify(leanRunner, sketch, (line) => {
          sketchLog += line + '\n';
          if (onStream) onStream(`[lean] ${line}`);
        }, options.signal);
        sketchErrors = recheck.errors.filter(e => e.severity === 'error');
        if (sketchErrors.length > 0) {
          console.warn('[LeanSFV] User-edited sketch has errors; proceeding anyway per user choice');
        }
      }
    }

    const sorryStatuses = sorries.map((s, i) => ({
      ...s, index: i, status: 'pending', fillCode: null, errors: null,
    }));

    let currentCode = sketch;
    let leanLog = sketchLog;

    // ── Phase 2 & 3: Fill each sorry ──────────────────────────────────────
    for (let i = 0; i < sorries.length; i++) {
      // Count sorries only in code regions (P-7: ignore comments)
      if (!this._countCodeSorries(currentCode)) {
        sorryStatuses.slice(i).forEach(s => { s.status = 'filled'; s.fillCode = currentCode; });
        break;
      }

      const sorry = sorryStatuses[i];
      sorry.status = 'filling';
      emitStatus('lean-filling', {
        sorryIndex: i, total: sorries.length,
        filled: sorryStatuses.filter(s => s.status === 'filled').length,
      });

      const prevSorryCount = this._countCodeSorries(currentCode);
      let fillErrors = [];
      let lastCandidate = currentCode;

      for (let attempt = 1; attempt <= maxFillRetries; attempt++) {
        if (attempt > 1) {
          emitStatus('lean-fill-retry', { sorryIndex: i, attempt, maxAttempts: maxFillRetries });
        }

        const prompt = attempt === 1
          ? this._buildFillPrompt(currentCode, sorry, i, sorries.length, results.proof, contextPrompt)
          : this._buildDiagnosePrompt(lastCandidate, sorry, fillErrors, contextPrompt, attempt);

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
        const fillResult = await this._cachedVerify(leanRunner, candidate, (line) => {
          lineOut += line + '\n';
          if (onStream) onStream(`[lean] ${line}`);
        }, options.signal);
        leanLog = lineOut;
        fillErrors = fillResult.errors.filter(e => e.severity === 'error');

        const newSorryCount = this._countCodeSorries(candidate);
        const madeProgress = newSorryCount < prevSorryCount;

        if (fillErrors.length === 0 && madeProgress) {
          currentCode = candidate;
          sorry.status = 'filled';
          sorry.fillCode = candidate;
          emitStatus('lean-fill-ok', { sorryIndex: i, total: sorries.length });
          break;
        }

        if (!madeProgress) {
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
    const anyFilled        = sorryStatuses.some(s => s.status === 'filled');
    const remainingSorries = this._countCodeSorries(currentCode);

    let finalLog = '';
    const finalResult = await this._cachedVerify(leanRunner, currentCode, (line) => { finalLog += line + '\n'; }, options.signal);
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

  // ── System prompt ─────────────────────────────────────────────────────────

  /**
   * Build the rich Lean 4 system prompt used for all sketch/fill/diagnose calls.
   * Includes tactic hierarchy, Lean 3 pitfall guards, and sorry annotation rules.
   */
  _buildLeanSys(usesMathlib = false) {
    const importLine = usesMathlib ? 'import Mathlib' : 'import Std';
    return `\
You are a Lean 4 proof assistant integrated into the Fermat theorem-proving pipeline.

IMPORTS: Every generated file must begin with \`${importLine}\`.

LEAN 4 vs LEAN 3 — avoid these common Lean 3 regressions:
- Use \`by\` for tactic blocks, NOT \`begin ... end\`
- Module names are UpperCamelCase: \`Nat.Prime\` not \`nat.prime\`
- \`And\` fields: \`h.left\` / \`h.right\`, not \`h.1\` / \`h.2\`
- Tactic separators: newlines or \`<;>\`, NOT commas
- \`ring\` not \`ring'\`; \`simp\` not \`simp_rw\` for simple rewrites
- \`rcases h with ⟨a, b⟩\` / \`obtain ⟨a, b⟩ := h\` for destructuring
- \`#check\` is a top-level command only — never use it inside a tactic block
- Case labels: \`case zero =>\` / \`case succ n ih =>\`, not comma-separated

TACTIC PRIORITY (try in order for each goal type):
- Linear arithmetic (ℤ/ℕ equalities, inequalities): \`omega\` → \`linarith\` → \`norm_num\`
- Ring / field identities:                           \`ring\` → \`field_simp; ring\`
- Decidable / small numerics:                        \`decide\` → \`norm_num\`
- Propositional tautology:                           \`tauto\` → \`aesop\`
- Existential with known witness:                    \`exact ⟨w, h⟩\` → \`refine ⟨?_, ?_⟩\`
- Set/finset membership:                             \`simp [Finset.mem_insert]\` → \`decide\`
- Structural induction:                              \`induction n with | zero => ... | succ n ih => ...\`
- Case split on hypothesis:                          \`rcases h with h₁ | h₂\` → \`obtain ⟨a, ha⟩ := h\`

SORRY ANNOTATION RULE: Every \`sorry\` in a skeleton MUST be annotated as
\`show T; sorry\` where T is the Lean type of the subgoal at that point.
If unsure of the exact type, write \`show ?_; sorry\` as a placeholder.
This annotation is REQUIRED — bare \`sorry\` without \`show T;\` is not acceptable.

Output ONLY a \`\`\`lean4 ... \`\`\` code block. No prose, no markdown outside the fence.`;
  }

  // ── Prompt builders ───────────────────────────────────────────────────────

  /** Build the sketch-generation prompt (Phase 1). */
  _buildSketchPrompt(contextPrompt, naturalProof, prevSketch, prevErrors, attempt) {
    if (attempt === 1) {
      return `\
Generate a Lean 4 proof skeleton with \`sorry\` placeholders.

RULES:
1. The skeleton MUST type-check with sorry allowed (no structural/syntax errors).
2. EVERY sorry MUST be annotated: \`show T; sorry\` where T is the expected type.
3. Do NOT fill in real proofs — only build the structure.
4. Include \`import Mathlib\` (or appropriate imports) at the top.

EXAMPLE — how to turn an informal proof into a skeleton:
  Informal: "We induct on n. Base: 0 + 0 = 0 by rfl. Step: assume n + 0 = n, then
             (n+1) + 0 = n + 1 follows because addition is defined recursively."
  Skeleton:
  \`\`\`lean4
  import Mathlib
  theorem add_zero (n : ℕ) : n + 0 = n := by
    induction n with
    | zero      => show 0 + 0 = 0; sorry
    | succ n ih => show n.succ + 0 = n.succ; sorry
  \`\`\`

MATHEMATICAL CONTEXT:
${contextPrompt}

INFORMAL PROOF TO FORMALIZE:
${naturalProof}`;
    }

    return `\
Your previous Lean 4 proof sketch had structural errors. Fix the STRUCTURE only.
Keep all \`sorry\` placeholders as-is — do not fill them in.

Previous sketch:
\`\`\`lean4
${prevSketch}
\`\`\`

Errors to fix:
${prevErrors.map(e => `  line ${e.line}: ${e.message}`).join('\n')}

Output the corrected \`\`\`lean4 ... \`\`\` code block.`;
  }

  /** Build the fill prompt for sorry #sorryIndex (Phase 2). */
  _buildFillPrompt(currentCode, sorry, sorryIndex, total, naturalProof, contextPrompt) {
    const typeHint = sorry.expectedType
      ? `\nExpected type (from Lean elaboration): \`${sorry.expectedType}\``
      : '';

    const hypHint = sorry.hypotheses?.length
      ? `\nLocal hypotheses at this point:\n${sorry.hypotheses.map(h => `  ${h}`).join('\n')}`
      : '';

    const declHint = sorry.enclosingDeclaration
      ? `\nEnclosing declaration:\n\`\`\`lean4\n${sorry.enclosingDeclaration}\n\`\`\``
      : '';

    return `\
Fill in exactly ONE \`sorry\` in the following Lean 4 proof sketch.

EXAMPLE — filling a sorry:
  Before (sorry #1 of 2):
  \`\`\`lean4
  theorem even_sq (n : ℕ) (h : 2 ∣ n) : 2 ∣ n ^ 2 := by
    obtain ⟨k, hk⟩ := h
    subst hk
    show 2 ∣ (2 * k) ^ 2; sorry
    show 2 ∣ k; sorry
  \`\`\`
  After (sorry #1 filled):
  \`\`\`lean4
  theorem even_sq (n : ℕ) (h : 2 ∣ n) : 2 ∣ n ^ 2 := by
    obtain ⟨k, hk⟩ := h
    subst hk
    exact ⟨2 * k ^ 2, by ring⟩
    show 2 ∣ k; sorry
  \`\`\`

SKETCH (filling sorry ${sorryIndex + 1} of ${total}):
\`\`\`lean4
${currentCode}
\`\`\`

The sorry to fill is near line ${sorry.line}:
\`\`\`
${sorry.surroundingCode}
\`\`\`
${typeHint}${hypHint}${declHint}

INFORMAL PROOF CONTEXT:
${naturalProof}

MATHEMATICAL CONTEXT:
${contextPrompt}

OUTPUT: The complete Lean 4 code with sorry #${sorryIndex + 1} replaced by a working proof.
Keep all OTHER \`sorry\` placeholders unchanged.
Output ONLY a \`\`\`lean4 ... \`\`\` code block.`;
  }

  /**
   * Build the diagnose/retry prompt for a failed fill.
   * @param {number} attempt — which retry (2 = first diagnose, 3 = second, etc.)
   */
  _buildDiagnosePrompt(code, sorry, errors, contextPrompt, attempt = 2) {
    const strategyHint = attempt >= 3
      ? '\nATTENTION: Your previous attempts have failed. Try a DIFFERENT approach — if you used `simp`, try explicit rewrites or `omega`; if you used tactic mode, try term mode.\n'
      : '';

    // Classify errors to give targeted hints
    const classifiedErrors = errors.map(e => {
      let hint = '';
      const msg = e.message || '';
      if (msg.includes('unknown identifier') || msg.includes('unknown constant')) {
        hint = ' [HINT: wrong name — check capitalisation or use fully-qualified module path]';
      } else if (msg.includes('type mismatch')) {
        hint = ' [HINT: types don\'t match — check implicit arguments or use explicit coercion]';
      } else if (msg.includes('unsolved goals')) {
        hint = ' [HINT: proof is incomplete — add more tactic steps or use `exact?`/`apply?`]';
      } else if (msg.includes('failed to synthesize')) {
        hint = ' [HINT: missing typeclass instance — try adding `inferInstance` or explicit instance]';
      } else if (msg.includes('function expected')) {
        hint = ' [HINT: applied a non-function — check implicit vs explicit argument braces `{ }` vs `( )`]';
      }
      return `  line ${e.line}: ${e.message}${hint}`;
    });

    const typeHint = sorry.expectedType
      ? `\nExpected type at this sorry: \`${sorry.expectedType}\``
      : '';

    const hypHint = sorry.hypotheses?.length
      ? `\nLocal hypotheses:\n${sorry.hypotheses.map(h => `  ${h}`).join('\n')}`
      : '';

    return `\
The following Lean 4 proof attempt failed. Fix the errors.
${strategyHint}
EXAMPLE — fixing a type-mismatch error:
  Broken:  \`exact Nat.prime n\`    -- error: unknown identifier 'Nat.prime'
  Fixed:   \`exact Nat.Prime n\`    -- Lean 4 uses UpperCamelCase

CURRENT CODE:
\`\`\`lean4
${code}
\`\`\`

LEAN ERRORS:
${classifiedErrors.join('\n')}

TARGET SUBGOAL (near line ${sorry.line}):
\`\`\`
${sorry.surroundingCode}
\`\`\`
${typeHint}${hypHint}

MATHEMATICAL CONTEXT:
${contextPrompt}

Output the COMPLETE corrected \`\`\`lean4 ... \`\`\` code block.
Keep unrelated \`sorry\` placeholders unchanged.`;
  }

  // ── Sorry parser ──────────────────────────────────────────────────────────

  /**
   * Parse the positions and context of every `sorry` in Lean code,
   * skipping sorries inside block comments (/-  -/) and line comments (--).*
   * Returns [{ line, col, expectedType, surroundingCode, enclosingDeclaration,
   *            hypotheses? }].
   *
   * Note: nested block comments (Lean 4 supports them) are handled by the
   * simple regex strip below, which only handles one level. Deeply-nested
   * comments are rare in proof files.
   */
  _parseSorries(code) {
    // Strip block comments to avoid matching sorry inside /- ... -/
    // Single-level only; nested /- /- -/ -/ may not strip fully (acceptable).
    const stripped = code.replace(/\/-([\s\S]*?)-\//g, m => ' '.repeat(m.length));
    const lines     = stripped.split('\n');
    const origLines = code.split('\n');
    const sorries   = [];

    for (let i = 0; i < lines.length; i++) {
      // Remove line comment from consideration
      const codePart = lines[i].replace(/--.*$/, '');
      if (!/\bsorry\b/.test(codePart)) continue;

      const col = codePart.indexOf('sorry');

      // Extract type annotation from original line (not stripped)
      const origLine   = origLines[i];
      const showMatch  = origLine.match(/\bshow\s+(.+?);\s*sorry\b/);
      const annotMatch = origLine.match(/\(\s*sorry\s*:\s*([^)]+)\)/);
      const expectedType = (showMatch?.[1] || annotMatch?.[1] || '').trim() || null;

      const ctxLines = origLines.slice(Math.max(0, i - 5), Math.min(origLines.length, i + 3));
      const enclosingDeclaration = this._findEnclosingDeclaration(origLines, i);

      sorries.push({
        line: i + 1,
        col,
        expectedType,
        surroundingCode: ctxLines.join('\n'),
        enclosingDeclaration,
      });
    }

    return sorries;
  }

  /**
   * Walk backward from `lineIdx` to find the nearest theorem/lemma/def/instance
   * declaration. Returns the declaration header (up to the `:= by` line) as a
   * string, or null if not found.
   */
  _findEnclosingDeclaration(lines, lineIdx) {
    const DECL_RE = /^(?:private\s+|protected\s+|noncomputable\s+)*(?:theorem|lemma|def|example|instance|abbrev)\b/;
    for (let i = lineIdx; i >= 0; i--) {
      if (!DECL_RE.test(lines[i])) continue;
      // Collect lines from the declaration keyword up to `:= by` / `:= {`
      const declLines = [];
      for (let k = i; k <= lineIdx && k < lines.length; k++) {
        declLines.push(lines[k]);
        if (/(:=\s*by\b|:=\s*\{)/.test(lines[k])) break;
      }
      return declLines.join('\n');
    }
    return null;
  }

  /**
   * Count `sorry` occurrences in non-comment code regions.
   * Replaces the old `(code.match(/\bsorry\b/g) || []).length` which
   * matched sorry inside comments and string literals.
   */
  _countCodeSorries(code) {
    const stripped = code.replace(/\/-([\s\S]*?)-\//g, m => ' '.repeat(m.length));
    const lines    = stripped.split('\n');
    let count = 0;
    for (const line of lines) {
      const codePart = line.replace(/--.*$/, '');
      const m = codePart.match(/\bsorry\b/g);
      if (m) count += m.length;
    }
    return count;
  }

  // ── Goal-state probe ──────────────────────────────────────────────────────

  /**
   * After the sketch type-checks, run a lean probe that inserts `trace_state`
   * before each bare (unannotated) sorry. Lean outputs the goal state as an
   * `information:` message, which we parse to populate sorry.expectedType and
   * sorry.hypotheses.
   *
   * Falls back gracefully: if the probe fails or trace_state is unavailable,
   * returns sorries from _parseSorries() without goal-state enrichment.
   */
  async _probeGoalStates(sketch, leanRunner, signal) {
    const sorries = this._parseSorries(sketch);
    if (!sorries.some(s => !s.expectedType)) return sorries; // all already annotated

    try {
      const probeCode   = this._buildProbeCode(sketch, sorries);
      // Don't use the cache here — the probe code differs from the real sketch
      const probeResult = await leanRunner.verify(probeCode, () => {}, signal);
      this._parseGoalStates(probeResult.rawOutput, sorries);
      const enriched = sorries.filter(s => s.expectedType).length;
      if (enriched) console.log(`[LeanSFV] Goal-state probe enriched ${enriched}/${sorries.length} sorries`);
    } catch (err) {
      console.warn('[LeanSFV] Goal-state probe failed (non-fatal):', err.message);
    }

    return sorries;
  }

  /**
   * Build a probe version of the sketch where each unannotated sorry is
   * replaced with `trace_state; sorry`. Lean's `trace_state` tactic emits
   * the current proof state as an `information:` log message.
   */
  _buildProbeCode(sketch, sorries) {
    const lines      = sketch.split('\n');
    const probeLines = [...lines];
    for (const sorry of sorries) {
      if (sorry.expectedType) continue;
      const idx = sorry.line - 1;
      if (idx >= 0 && idx < probeLines.length) {
        // Replace the first `sorry` on this line with `trace_state; sorry`
        probeLines[idx] = probeLines[idx].replace(/\bsorry\b/, 'trace_state; sorry');
      }
    }
    return probeLines.join('\n');
  }

  /**
   * Parse Lean's rawOutput for trace_state information messages and
   * populate sorry.expectedType / sorry.hypotheses in-place.
   *
   * Expected format in rawOutput (multi-line):
   *   "path/file.lean:LINE:COL: information: [optional case label]"
   *   "h₁ : T₁"
   *   "⊢ goalType"
   */
  _parseGoalStates(rawOutput, sorries) {
    const outputLines = rawOutput.split('\n');

    for (const sorry of sorries) {
      if (sorry.expectedType !== null) continue;

      const targetLine = sorry.line;

      // Find the `information:` message emitted at sorry.line by trace_state
      let infoIdx = -1;
      for (let i = 0; i < outputLines.length; i++) {
        const m = outputLines[i].match(/:(\d+):\d+: information: (.*)/);
        if (m && parseInt(m[1], 10) === targetLine) {
          infoIdx = i;
          break;
        }
      }
      if (infoIdx < 0) continue;

      // Collect multi-line content: first line's suffix + continuation lines
      let content = outputLines[infoIdx].replace(/.*?: information: /, '');
      let j = infoIdx + 1;
      while (j < outputLines.length && !outputLines[j].match(/^.*?:\d+:\d+: /)) {
        content += '\n' + outputLines[j];
        j++;
      }

      const infoLines = content.split('\n').filter(l => l.trim());
      const goalIdx   = infoLines.findIndex(l => l.trim().startsWith('⊢'));
      if (goalIdx >= 0) {
        sorry.expectedType = infoLines[goalIdx].replace(/^\s*⊢\s*/, '').trim();
      }

      const hyps = infoLines
        .slice(0, goalIdx >= 0 ? goalIdx : infoLines.length)
        .filter(l => l.trim() && !/^case\b/.test(l.trim()));
      if (hyps.length) {
        sorry.hypotheses = hyps.map(l => l.trim());
      }
    }
  }

  // ── Verify cache ──────────────────────────────────────────────────────────

  /**
   * Cache wrapper around leanRunner.verify().
   * Keyed by a hash of the source code. Avoids re-running lean on identical
   * source (common when diagnose retries produce the same code, or when the
   * final-verdict pass re-verifies code already verified during the fill loop).
   */
  async _cachedVerify(leanRunner, code, onLine, signal) {
    const key = this._hashCode(code);
    if (this._verifyCache.has(key)) {
      console.log('[LeanSFV] Verify cache hit');
      const cached = this._verifyCache.get(key);
      // Replay output lines so the UI log stays consistent
      if (onLine) {
        for (const line of cached.rawOutput.split('\n')) {
          if (line) onLine(line);
        }
      }
      return cached;
    }

    const result = await leanRunner.verify(code, onLine, signal);

    // Only cache when not cancelled (abort yields partial results)
    if (!signal?.aborted) {
      this._verifyCache.set(key, result);
      // Keep the cache bounded — evict oldest entry above 60 items
      if (this._verifyCache.size > 60) {
        this._verifyCache.delete(this._verifyCache.keys().next().value);
      }
    }
    return result;
  }

  /** Simple djb2-style hash of a string. Sufficient for cache keying. */
  _hashCode(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  // ── LLM dispatch ─────────────────────────────────────────────────────────

  /**
   * Unified LLM call — uses Claude CLI when available, ClaudeProvider otherwise.
   * The provider path goes through the llm-provider abstraction layer.
   */
  async _callLlm(prompt, onStream, apiKey, model, systemPrompt = '', signal = undefined) {
    if (signal?.aborted) {
      const err = new Error('Cancelled before LLM call');
      err.code = 'FERMAT_CANCELLED';
      throw err;
    }

    if (this._hasClaudeCli) {
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
      return this._runClaude(fullPrompt, onStream, signal, model);
    }

    // Direct API path — use provider abstraction
    const provider = this._getOrUpdateProvider(apiKey, model);
    const messages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      { role: 'user', content: prompt },
    ];
    try {
      return await provider.complete(messages, { signal, onToken: onStream });
    } catch (err) {
      if (err.code === 'FERMAT_CANCELLED') throw err;
      throw classifyAndAnnotateError(err);
    }
  }

  /** Run claude CLI in non-interactive (print) mode. */
  _runClaude(prompt, onStream, signal = undefined, model = undefined) {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--model', model || 'claude-sonnet-4-6',
      ];

      const proc = spawn(this._claudePath, args, {
        cwd: this.projectRoot,
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

      // B-06: surface stdin EPIPE instead of letting it bubble
      proc.stdin.on('error', (err) => {
        if (err.code === 'EPIPE') {
          console.warn('[ClaudeCLI] stdin EPIPE — child exited before reading full prompt');
        } else {
          console.warn(`[ClaudeCLI] stdin error: ${err.message}`);
        }
      });
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch (err) {
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

  // ── Lean 4 helpers ────────────────────────────────────────────────────────

  /**
   * Extract the theorem/lemma declaration header from Lean 4 code.
   * Handles `:= by`, `:= {`, and term-mode (`:= expr`).
   */
  _parseTheoremStatement(code) {
    if (!code) return null;
    // Find `:= by` or `:= {` at depth 0 (bracket-aware scan)
    let depth = 0;
    const tokens = [['/-', -1], ['-/', +1]]; // block comment tracking handled separately
    const lines = code.split('\n');
    let charCount = 0;
    for (const line of lines) {
      const lineStart = charCount;
      // Check for `:= by` or `:= {` not inside a comment
      const assignMatch = line.match(/:=\s*(by\b|\{)/);
      if (assignMatch && depth === 0) {
        const assignIdx = charCount + assignMatch.index;
        return code.slice(0, assignIdx).trim();
      }
      charCount += line.length + 1;
      void tokens; void depth; void lineStart;
    }
    // Fallback: first meaningful lines
    const meaningful = code.split('\n').filter(
      l => l.trim() && !l.startsWith('import') && !l.startsWith('open') &&
           !l.startsWith('--') && !l.startsWith('/-'),
    );
    return meaningful.slice(0, 5).join('\n');
  }

  /**
   * Extract the first ```lean4 ... ``` (or ```lean ...) block from a string.
   */
  _extractLeanBlock(text) {
    if (!text) return '';
    const m = text.match(/```(?:lean4?)\n([\s\S]*?)```/);
    if (m) return m[1].trim();
    const m2 = text.match(/```\n([\s\S]*?)```/);
    if (m2) return m2[1].trim();
    return text.trim();
  }

  // ── Skill loader ──────────────────────────────────────────────────────────

  _loadSkill(name) {
    const skillPath = path.join(this.skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Skill not found: ${skillPath}`);
    }
    return fs.readFileSync(skillPath, 'utf-8').replace(/^---[\s\S]*?---\n*/, '');
  }

  // ── Target node resolution ────────────────────────────────────────────────

  _findTargetNode(outline, marker) {
    if (marker.lineNumber) {
      return outline.nodes.find(n =>
        n.proveItMarker && Math.abs(n.lineNumber - marker.lineNumber) < 10,
      );
    }
    if (marker.id) {
      return outline.nodes.find(n => n.id === marker.id);
    }
    if (marker.label) {
      return outline.nodes.find(n =>
        n.labels?.some(l => marker.label.includes(l)) ||
        marker.label.includes(n.name),
      );
    }
    return null;
  }

  // ── LaTeX proof extraction ────────────────────────────────────────────────

  /**
   * Extract \begin{proof}...\end{proof} from model output.
   * B-12: only wrap output that actually looks like a LaTeX proof body.
   */
  _extractProof(text) {
    if (!text) return '';
    const match = text.match(/\\begin\{proof\}[\s\S]*?\\end\{proof\}/);
    if (match) return match[0];

    const trimmed = text.trim();
    if (trimmed.startsWith('\\begin{proof}')) return trimmed;

    if (this._looksLikeProofBody(trimmed)) {
      return `\\begin{proof}\n${trimmed}\n\\end{proof}`;
    }

    console.warn('[Prove] Model did not return a LaTeX proof; surfacing as placeholder');
    const preview = trimmed.replace(/\n/g, ' ').slice(0, 160);
    return `% [FERMAT] The model did not produce a LaTeX proof.\n% Preview: ${preview}${preview.length >= 160 ? '…' : ''}\n\\begin{proof}\n  % TODO: model output was not a proof — inspect the model response and retry.\n\\end{proof}`;
  }

  _looksLikeProofBody(text) {
    if (!text) return false;
    if (/\b(I cannot|I can't|I'm sorry|I apologize|As an AI)\b/i.test(text)) return false;
    if (/^```/m.test(text) || /\btheorem\s+\w+\s*:/.test(text) || /:=\s*by\b/.test(text)) return false;
    if (/\\(begin|end|QED|qed|square|blacksquare|textit|emph|cite|ref)\b/.test(text)) return true;
    if (/\$[^$]*\$/.test(text)) return true;
    if (/\\\\/.test(text)) return true;
    return false;
  }

  recordAcceptedProof(label, statementTeX, proofTeX) {
    this.contextAssembler.recordAcceptedProof(label, statementTeX, proofTeX);
  }
}

module.exports = { ClaudeCodeBackend };
