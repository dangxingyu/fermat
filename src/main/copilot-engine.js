const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const { ClaudeCodeBackend } = require('./claude-code-backend');
const { LeanRunner } = require('./lean-runner');

/**
 * FermatEngine
 *
 * Manages async proof requests. Detects [PROVE IT: Easy|Medium|Hard] markers,
 * dispatches proving to ClaudeCodeBackend, and streams results back.
 *
 * Architecture:
 *   - Each marker becomes a ProofTask in a queue
 *   - Tasks run concurrently up to a configurable limit
 *   - Easy proofs auto-inline; Medium/Hard go to review panel
 *   - ClaudeCodeBackend handles context assembly + skill-based proving
 *   - Falls back to direct API calls if Claude Code CLI not available
 *
 * Proving pipeline (for Medium/Hard):
 *   1. Sketch  — plan the proof strategy, identify prerequisites
 *   2. Prove   — write the full proof using the assembled context
 *   3. Verify  — LLM-as-judge checks correctness
 *   4. Retry   — if verification fails, attempt self-correction (once)
 */

class ProofTask {
  constructor(marker, model) {
    this.id = marker.id || uuidv4();
    this.marker = marker;
    this.model = model;
    this.status = 'queued';     // queued | sketching | proving | verifying | completed | failed | cancelled
    this.result = null;         // { proof, sketch?, verdict? }
    this.error = null;
    this.startedAt = null;
    this.completedAt = null;
    this.abortController = new AbortController();
  }
}

class FermatEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = {
      defaultModel: 'claude',
      models: {
        claude: { apiKey: '', model: 'claude-sonnet-4-6' },
      },
      maxConcurrent: 3,
      autoInlineDifficulty: ['Easy'],
      skipVerifyDifficulty: ['Easy'],  // Skip verification for easy proofs
      verificationMode: 'off',         // 'off' | 'lean'
      lean: { binaryPath: '', maxRetries: 3 },
    };
    this.tasks = new Map();
    this.running = 0;
    this.queue = [];
    this.backend = new ClaudeCodeBackend();
    // Q-02: accept an injected LeanRunner instead of spawning a second one.
    // main.js creates a single LeanRunner for IPC and passes it in here,
    // so we don't duplicate `which lean` detection or track divergent state.
    this.leanRunner = options.leanRunner || new LeanRunner();
    // Resolvers for the lean statement review pause point.
    // Maps taskId → resolve fn from the Promise created in _leanSketchFillVerify.
    this._statementReviewResolvers = new Map();

    // Store the latest document content for context assembly
    this._latestContent = '';
    console.log('[Copilot] Engine initialized');
  }

  configure(config) {
    Object.assign(this.config, config);
    // B-11 defence-in-depth: never let NaN or non-finite numerics reach the
    // queue scheduler (while-loop `running < NaN` is always false, which
    // silently disables all proofs).
    if (!Number.isFinite(this.config.maxConcurrent) || this.config.maxConcurrent < 1) {
      console.warn(`[Copilot] Invalid maxConcurrent=${this.config.maxConcurrent}, clamping to 1`);
      this.config.maxConcurrent = 1;
    }
    if (this.config.lean && !Number.isFinite(this.config.lean.maxRetries)) {
      this.config.lean.maxRetries = 3;
    }
    // Propagate mathlib flag to the runner whenever it changes.
    // Binary detection (detect()) is NOT triggered here — that is main.js's
    // responsibility so it can deduplicate across startup and user-initiated
    // saves.  Calling detect() from here produced three back-to-back
    // invocations at startup (settings-restore + did-finish-load + handler).
    if (config?.lean !== undefined) {
      this.leanRunner.setUsesMathlib(this.config.lean?.usesMathlib ?? false);
    }
    const model = this.config.models?.claude?.model || this.config.defaultModel || '(default)';
    console.log(`[Copilot] Configured: model=${model} | maxConcurrent=${this.config.maxConcurrent} | verifyMode=${this.config.verificationMode ?? 'off'} | lean.mathlib=${!!this.config.lean?.usesMathlib} | lean.repl=${!!this.config.lean?.useRepl}`);
  }

  /**
   * Update the document content (called on each edit).
   * The backend uses this to assemble context.
   */
  updateContent(content) {
    this._latestContent = content;
  }

  /**
   * Submit a proof request from a [PROVE IT: X] marker
   */
  submitProofRequest(marker) {
    const model = marker.preferredModel || this.config.defaultModel;
    const task = new ProofTask(marker, model);
    this.tasks.set(task.id, task);
    this.queue.push(task);
    this._processQueue();
    return { taskId: task.id, status: 'queued' };
  }

  cancelProof(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    // Always abort — even for queued tasks that haven't started — so that
    // an already-resolved statement review or in-flight network call can see
    // the signal. The signal is forwarded into the backend pipeline (B-03).
    try { task.abortController.abort(); } catch {}
    task.status = 'cancelled';
    // Drop the task's statement-review resolver if one is outstanding so the
    // sketch→fill pipeline unblocks and returns early.
    this.cancelLeanStatement(taskId);
    // Remove from queue so _processQueue doesn't have to skip the corpse (B-09)
    const qi = this.queue.indexOf(task);
    if (qi >= 0) this.queue.splice(qi, 1);
    this.tasks.delete(taskId);
    return true;
  }

  getStatus() {
    const statuses = {};
    for (const [id, task] of this.tasks) {
      statuses[id] = {
        id,
        difficulty: task.marker.difficulty,
        label: task.marker.label,
        model: task.model,
        status: task.status,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        hasSketch: !!task.result?.sketch,
        hasVerdict: !!task.result?.verdict,
      };
    }
    return statuses;
  }

  // ─── Lean statement review controls ──────────────────────────────────────

  /**
   * Confirm the lean theorem statement — resume the pipeline as-is.
   */
  confirmLeanStatement(taskId) {
    const resolve = this._statementReviewResolvers.get(taskId);
    if (resolve) {
      resolve({ action: 'confirm' });
      this._statementReviewResolvers.delete(taskId);
    }
  }

  /**
   * Submit a user-edited version of the lean sketch — re-verify and continue.
   * @param {string} newCode — the full edited Lean 4 source
   */
  editLeanStatement(taskId, newCode) {
    const resolve = this._statementReviewResolvers.get(taskId);
    if (resolve) {
      resolve({ action: 'edit', newCode });
      this._statementReviewResolvers.delete(taskId);
    }
  }

  /**
   * Cancel the lean verification pipeline for this task.
   */
  cancelLeanStatement(taskId) {
    const resolve = this._statementReviewResolvers.get(taskId);
    if (resolve) {
      resolve({ action: 'cancel' });
      this._statementReviewResolvers.delete(taskId);
    }
  }

  /**
   * Record that a proof was accepted — feeds into proof memory for
   * future proofs to reference.
   */
  recordAcceptedProof(label, statementTeX, proofTeX) {
    this.backend.recordAcceptedProof(label, statementTeX, proofTeX);
  }

  async _processQueue() {
    while (this.queue.length > 0 && this.running < this.config.maxConcurrent) {
      const task = this.queue.shift();
      if (task.status === 'cancelled') continue;
      this.running++;
      task.status = 'running';
      task.startedAt = Date.now();
      this.emit('proof:started', { taskId: task.id, marker: task.marker });
      this._executeProof(task).finally(() => {
        this.running--;
        this._processQueue();
      });
    }
  }

  async _executeProof(task) {
    try {
      const content = task.marker.fullContent || this._latestContent;
      if (!content) {
        throw new Error('No document content available. Compile first.');
      }

      const difficulty = task.marker.difficulty || 'Medium';
      const modelConfig = this.config.models[task.model] || this.config.models.claude;

      // Update task status as we progress through the pipeline
      const updateStatus = (status) => {
        task.status = status;
        this.emit('proof:status', { taskId: task.id, status });
      };

      // Emit streaming chunks to the renderer
      const onStream = (text) => {
        this.emit('proof:streaming', {
          taskId: task.id,
          text,
          status: task.status,
        });
      };

      updateStatus(difficulty === 'Easy' ? 'proving' : 'sketching');

      // QA P1-03: when the user has opted into lean verification but the
      // binary isn't available, surface a dedicated status so the renderer
      // can show a visible warning. The proof still runs without lean —
      // we just tell the user formal verification is being skipped so they
      // aren't left wondering whether it silently failed.
      if (this.config.verificationMode === 'lean' && !this.leanRunner?.isAvailable) {
        this.emit('proof:status', {
          taskId: task.id,
          phase: 'lean-unavailable',
          message: 'Lean binary not found — verification will be skipped. Install lean or fix the path in Settings.',
        });
      }

      const onStatus = (statusData) => {
        this.emit('proof:status', { taskId: task.id, ...statusData });
      };

      // Callback invoked by _leanSketchFillVerify when the sketch is ready for review.
      // Stores the resolver so confirmLeanStatement / editLeanStatement / cancelLeanStatement
      // can resume the pipeline from the IPC layer.
      const onStatementReview = ({ statement, sketch, resolve }) => {
        this._statementReviewResolvers.set(task.id, resolve);
        this.emit('proof:status', {
          taskId: task.id,
          phase: 'lean-statement-review',
          statement,
          sketch,
        });
      };

      const result = await this.backend.prove(content, task.marker, {
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        skipVerify: this.config.skipVerifyDifficulty.includes(difficulty),
        onStream,
        onStatus,
        verificationMode: this.config.verificationMode,
        leanRunner: this.leanRunner,
        maxLeanRetries: this.config.lean?.maxRetries ?? 3,
        onStatementReview,
        taskId: task.id,
        signal: task.abortController.signal, // B-03: forward cancel into backend
      });

      task.status = 'completed';
      task.completedAt = Date.now();
      task.result = result;

      const autoInline = this.config.autoInlineDifficulty.includes(difficulty);

      // QA P1-03: only include lean fields when lean ACTUALLY ran. The
      // renderer's App.jsx guard is `data.leanCode !== undefined` — using
      // `|| null` here coerced the skipped-lean case to `null`, which
      // passed the guard and rendered a spurious `lean-failed` panel for
      // a proof that never touched lean. Conditional spread keeps the
      // "didn't run" case truly undefined.
      this.emit('proof:completed', {
        taskId: task.id,
        marker: task.marker,
        proof: result.proof,
        sketch: result.sketch || null,
        verdict: result.verdict || null,
        autoInline,
        ...(result.leanCode !== undefined ? {
          leanCode: result.leanCode,
          leanVerified: result.leanVerified ?? null,
          leanLog: result.leanLog || null,
          leanErrors: result.leanErrors || null,
          sorries: result.sorries || null,
          leanStatement: result.leanStatement || null,
        } : {}),
      });
    } catch (err) {
      // B-03: treat any abort signal hit as a clean cancellation (some paths
      // re-throw generic Error with a "cancelled" code instead of DOMException)
      if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 'FERMAT_CANCELLED') {
        task.status = 'cancelled';
        return;
      }
      task.status = 'failed';
      task.error = err.message;
      task.completedAt = Date.now();
      this.emit('proof:failed', {
        taskId: task.id,
        marker: task.marker,
        error: err.message,
        // Structured error fields set by classifyAndAnnotateError() in the backend.
        // Renderer uses these to show a helpful toast instead of a raw stack trace.
        code: err.fermatCode || 'UNKNOWN_ERROR',
        userMessage: err.fermatUserMessage || err.message,
      });
    }
  }
}

module.exports = { FermatEngine, ProofTask };
