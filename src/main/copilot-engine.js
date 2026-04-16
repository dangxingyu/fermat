const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const { ClaudeCodeBackend } = require('./claude-code-backend');

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
  constructor() {
    super();
    this.config = {
      defaultModel: 'claude',
      models: {
        claude: { apiKey: '', model: 'claude-sonnet-4-6' },
      },
      maxConcurrent: 3,
      autoInlineDifficulty: ['Easy'],
      skipVerifyDifficulty: ['Easy'],  // Skip verification for easy proofs
    };
    this.tasks = new Map();
    this.running = 0;
    this.queue = [];
    this.backend = new ClaudeCodeBackend();

    // Store the latest document content for context assembly
    this._latestContent = '';
  }

  configure(config) {
    Object.assign(this.config, config);
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
    if (['running', 'sketching', 'proving', 'verifying'].includes(task.status)) {
      task.abortController.abort();
    }
    task.status = 'cancelled';
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

      const result = await this.backend.prove(content, task.marker, {
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        skipVerify: this.config.skipVerifyDifficulty.includes(difficulty),
        onStream,
      });

      task.status = 'completed';
      task.completedAt = Date.now();
      task.result = result;

      const autoInline = this.config.autoInlineDifficulty.includes(difficulty);

      this.emit('proof:completed', {
        taskId: task.id,
        marker: task.marker,
        proof: result.proof,
        sketch: result.sketch || null,
        verdict: result.verdict || null,
        autoInline,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
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
