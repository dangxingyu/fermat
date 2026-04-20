/**
 * LeanRepl
 *
 * Persistent Lean REPL wrapper using leanprover-community/repl.
 * Replaces the per-verification cold-start (lean binary spawn) with a single
 * long-lived process that loads Mathlib once and accepts subsequent commands.
 *
 * Protocol:
 *   stdin:  {"cmd": "<lean source>", "env": N}  followed by a blank line
 *   stdout: {"env": N, "messages": [...], "sorries": [...]}  followed by blank line
 *
 * Import commands (startup) omit the "env" field.
 * Each verify() call branches from _baseEnv (post-import snapshot), keeping
 * declarations from different proof attempts isolated from each other.
 *
 * verify() output is compatible with LeanRunner.verify() so it can be used
 * as a drop-in replacement from LeanRunner.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
// Startup import (lake exe repl + import Mathlib + olean load) can be slow.
const STARTUP_TIMEOUT_MS = 300_000;
const MAX_RESTARTS = 5;
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

class LeanRepl {
  /**
   * @param {string} workspacePath  absolute path to the lake project root
   * @param {object} [opts]
   * @param {string} [opts.lakeBin]        explicit lake binary path
   * @param {boolean} [opts.usesMathlib]   default true — import Mathlib at startup
   * @param {number} [opts.timeoutMs]      per-verify timeout (default 120 000 ms)
   */
  constructor(workspacePath, opts = {}) {
    this._workspacePath = workspacePath;
    this._lakeBin = opts.lakeBin || null;
    this._usesMathlib = opts.usesMathlib !== false;
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

    this._proc = null;
    this._buf = '';
    this._baseEnv = null;
    this._ready = false;
    this._stopped = false;
    this._restartCount = 0;
    this._startPromise = null;

    // Sequential send queue: { cmd, envId, resolve, reject, timer }
    this._queue = [];
    this._inflight = null;
  }

  /** True when the REPL is started and the initial import has completed. */
  get isReady() { return this._ready && !this._stopped; }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Start the REPL and load the initial import. Idempotent — safe to call
   * multiple times; concurrent calls share the same in-flight promise.
   * @returns {Promise<void>}
   */
  start() {
    if (this._stopped) return Promise.reject(new Error('LeanRepl has been stopped'));
    if (this._ready) return Promise.resolve();
    if (this._startPromise) return this._startPromise;

    this._startPromise = this._doStart()
      .then(() => { this._startPromise = null; })
      .catch(err => { this._startPromise = null; throw err; });
    return this._startPromise;
  }

  /**
   * Verify lean source, same interface as LeanRunner.verify().
   *
   * @param {string}   leanSource  complete Lean 4 source
   * @param {function} onLine      called with each synthesised output line
   * @param {AbortSignal} [signal] optional cancellation
   * @returns {Promise<{ success, errors, rawOutput, usedMathlib, timedOut }>}
   */
  async verify(leanSource, onLine, signal) {
    if (signal?.aborted) {
      const err = new Error('Cancelled');
      err.code = 'FERMAT_CANCELLED';
      throw err;
    }

    if (!this._ready) {
      try { await this.start(); } catch (startErr) {
        return {
          success: false,
          errors: [{ file: 'theorem.lean', line: 0, col: 0, severity: 'error',
                     message: `REPL unavailable: ${startErr.message}` }],
          rawOutput: '',
          usedMathlib: this._usesMathlib,
          timedOut: false,
        };
      }
    }

    const cmd = this._prepareSource(leanSource);
    let response;
    try {
      response = await this._send(cmd, this._baseEnv, signal, this._timeoutMs);
    } catch (err) {
      if (err.code === 'FERMAT_CANCELLED') throw err;
      return {
        success: false,
        errors: [{ file: 'theorem.lean', line: 0, col: 0, severity: 'error',
                   message: err.message }],
        rawOutput: err.message,
        usedMathlib: this._usesMathlib,
        timedOut: /timed out/i.test(err.message),
      };
    }

    return this._responseToResult(response, onLine);
  }

  /**
   * Graceful shutdown — closes stdin and waits for the process to exit.
   */
  async stop() {
    this._stopped = true;
    this._ready = false;

    const pending = this._inflight
      ? [this._inflight, ...this._queue]
      : [...this._queue];
    this._inflight = null;
    this._queue = [];
    const stopErr = new Error('LeanRepl stopped');
    for (const item of pending) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(stopErr);
    }

    if (this._proc) {
      try { this._proc.stdin.end(); } catch {}
      await new Promise(resolve => {
        const t = setTimeout(() => {
          try { this._proc?.kill('SIGKILL'); } catch {}
          resolve();
        }, 2000);
        this._proc?.once('close', () => { clearTimeout(t); resolve(); });
      });
      this._proc = null;
    }
  }

  // ─── Startup ─────────────────────────────────────────────────────────────

  async _doStart() {
    const lakeBin = this._lakeBin || this._findLake();
    if (!lakeBin) throw new Error('lake binary not found — install elan/lean');

    const env = this._buildEnv();
    this._proc = spawn(lakeBin, ['exe', 'repl'], {
      cwd: this._workspacePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._buf = '';

    this._proc.stdout.on('data', chunk => this._onData(chunk));
    this._proc.stderr.on('data', chunk => {
      console.warn('[LeanRepl] stderr:', chunk.toString().trimEnd());
    });
    this._proc.on('close', code => this._onClose(code));
    this._proc.on('error', err => this._onError(err));

    // Load imports — omit "env" field so the REPL treats this as module-level
    const importLine = this._usesMathlib ? 'import Mathlib' : 'import Std';
    console.log(`[LeanRepl] Starting — ${importLine} (workspace: ${this._workspacePath})`);

    const response = await this._send(importLine, null, null, STARTUP_TIMEOUT_MS);

    const importError = response.messages?.find(m => m.severity === 'error');
    if (importError) {
      throw new Error(`REPL import failed: ${importError.data}`);
    }

    this._baseEnv = response.env ?? 0;
    this._ready = true;
    this._restartCount = 0;
    console.log(`[LeanRepl] Ready — baseEnv=${this._baseEnv}`);
  }

  // ─── Protocol ─────────────────────────────────────────────────────────────

  /**
   * Queue a command and return a promise that resolves with the JSON response.
   * envId === null → omit "env" field (used for import commands).
   */
  _send(cmd, envId, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = (timeoutMs ?? this._timeoutMs) > 0
        ? setTimeout(() => {
            console.warn(`[LeanRepl] Command timed out after ${timeoutMs ?? this._timeoutMs}ms — killing process`);
            try { this._proc?.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { this._proc?.kill('SIGKILL'); } catch {} }, 1500);
            const err = new Error(`lean REPL timed out after ${timeoutMs ?? this._timeoutMs}ms`);
            err.timedOut = true;
            item.reject(err);
          }, timeoutMs ?? this._timeoutMs)
        : null;

      const item = {
        cmd, envId,
        resolve: resp  => { if (timer) clearTimeout(timer); resolve(resp); },
        reject:  err   => { if (timer) clearTimeout(timer); reject(err); },
        timer,
      };

      if (signal) {
        const onAbort = () => {
          const idx = this._queue.indexOf(item);
          if (idx >= 0) {
            // Not yet sent — remove from queue
            this._queue.splice(idx, 1);
            if (timer) clearTimeout(timer);
          } else if (this._inflight === item) {
            // Already in-flight — kill the REPL to unblock (will auto-restart)
            try { this._proc?.kill('SIGTERM'); } catch {}
            if (timer) clearTimeout(timer);
          } else {
            return; // already resolved/rejected
          }
          const err = new Error('Cancelled');
          err.code = 'FERMAT_CANCELLED';
          reject(err);
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this._queue.push(item);
      this._drainQueue();
    });
  }

  _drainQueue() {
    if (this._inflight || !this._queue.length || !this._proc) return;

    const item = this._queue.shift();
    this._inflight = item;

    const cmdObj = item.envId !== null && item.envId !== undefined
      ? { cmd: item.cmd, env: item.envId }
      : { cmd: item.cmd };

    try {
      this._proc.stdin.write(JSON.stringify(cmdObj) + '\n\n');
    } catch (err) {
      this._inflight = null;
      item.reject(new Error(`Failed to write to REPL stdin: ${err.message}`));
      this._drainQueue();
    }
  }

  _onData(chunk) {
    this._buf += chunk.toString();

    // Responses are terminated by a blank line (\n\n)
    const parts = this._buf.split('\n\n');
    this._buf = parts.pop(); // keep the incomplete trailing part

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      let response;
      try { response = JSON.parse(trimmed); }
      catch {
        console.warn('[LeanRepl] Unexpected non-JSON from stdout:', trimmed.slice(0, 200));
        continue;
      }

      const item = this._inflight;
      if (item) {
        this._inflight = null;
        item.resolve(response);
        this._drainQueue();
      }
    }
  }

  _onClose(code) {
    const wasReady = this._ready;
    this._ready = false;
    this._proc = null;
    this._buf = '';

    if (this._inflight) {
      this._inflight.reject(new Error(`REPL process exited (code ${code})`));
      this._inflight = null;
    }

    if (this._stopped) return;

    if (wasReady && this._restartCount < MAX_RESTARTS) {
      const delay = RESTART_BACKOFF_MS[this._restartCount] ?? 30_000;
      this._restartCount++;
      console.warn(`[LeanRepl] Crashed (code ${code}), restart ${this._restartCount}/${MAX_RESTARTS} in ${delay}ms`);
      setTimeout(() => {
        this._doStart().catch(err => console.error('[LeanRepl] Restart failed:', err.message));
      }, delay);
    } else {
      console.error(`[LeanRepl] Exited (code ${code}); max restarts reached or not yet ready`);
    }
  }

  _onError(err) {
    console.error('[LeanRepl] Spawn error:', err.message);
    if (this._inflight) {
      this._inflight.reject(err);
      this._inflight = null;
    }
  }

  // ─── Response → result conversion ────────────────────────────────────────

  /**
   * Convert a REPL JSON response to the lean-runner verify result shape.
   *
   * REPL message severities use 'information'; lean-runner uses 'info'.
   * rawOutput lines are reconstructed in lean-runner diagnostic format so that
   * claude-code-backend._parseGoalStates() can find 'information:' lines from
   * the 'sorries' array (REPL gives us elaborated goal states directly).
   */
  _responseToResult(response, onLine) {
    const errors = [];
    const rawLines = [];

    for (const msg of (response.messages ?? [])) {
      const severity = msg.severity === 'information' ? 'info' : (msg.severity ?? 'error');
      const line = msg.pos?.line ?? 0;
      const col  = msg.pos?.column ?? 0;
      const text = msg.data ?? '';
      errors.push({ file: 'theorem.lean', line, col, severity, message: text });
      // Use 'information' (not 'info') in rawOutput — _parseGoalStates scans for it
      const rawSeverity = msg.severity ?? 'error';
      rawLines.push(`theorem.lean:${line}:${col}: ${rawSeverity}: ${text}`);
    }

    // Emit sorry goal states as 'information:' lines so _parseGoalStates can
    // read elaborated ⊢ types without needing a separate trace_state probe.
    for (const sorry of (response.sorries ?? [])) {
      const line = sorry.pos?.line ?? 0;
      const col  = sorry.pos?.column ?? 0;
      rawLines.push(`theorem.lean:${line}:${col}: information: `);
      if (sorry.goal) rawLines.push(...sorry.goal.split('\n'));
    }

    if (onLine) rawLines.forEach(l => onLine(l));

    const realErrors = errors.filter(e => e.severity === 'error');
    return {
      success: realErrors.length === 0,
      errors,
      rawOutput: rawLines.join('\n').trim(),
      usedMathlib: this._usesMathlib,
      timedOut: false,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Strip import lines from the source — the REPL's base env already has them
   * loaded. Sending them again would cause 'import after declarations' errors.
   */
  _prepareSource(leanSource) {
    return leanSource
      .split('\n')
      .filter(line => !/^\s*import\s/.test(line))
      .join('\n')
      .trim();
  }

  _findLake() {
    const candidates = [
      process.env.LAKE || null,
      (() => {
        try {
          return execFileSync('which', ['lake'], {
            timeout: 2000, stdio: 'pipe',
            env: { ...process.env, PATH: this._buildPathStr() },
          }).toString().trim() || null;
        } catch { return null; }
      })(),
      path.join(os.homedir(), '.elan', 'bin', 'lake'),
    ].filter(Boolean);

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  _buildPathStr() {
    return [
      path.join(os.homedir(), '.elan', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      process.env.PATH || '',
    ].filter(Boolean).join(':');
  }

  _buildEnv() {
    return {
      ...process.env,
      // Tell the REPL process its per-command timeout (in seconds)
      LEAN_REPL_TIMEOUT: String(Math.ceil(this._timeoutMs / 1000)),
      PATH: this._buildPathStr(),
    };
  }
}

module.exports = { LeanRepl };
