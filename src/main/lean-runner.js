/**
 * LeanRunner
 *
 * Manages the local Lean 4 verification environment for Fermat.
 *
 * Responsibilities:
 *   - Locate the lean binary (settings override → PATH → ~/.elan/bin/lean)
 *   - Write generated Lean 4 code to a temp file and run `lean --run` on it
 *   - Stream stdout/stderr back line-by-line via a callback
 *   - Parse error messages into { line, col, message } structs for the frontend
 *
 * We intentionally use `lean` directly (not `lake build`) for single-theorem
 * verification — lake requires a full project setup and is much slower to
 * initialise.  For mathlib-dependent proofs the user would need a lake project,
 * which is a separate opt-in workflow.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Lean error line format:  /path/to/file.lean:LINE:COL: error: MESSAGE
const LEAN_ERROR_RE = /^(.+?):(\d+):(\d+): (error|warning|info): (.+)$/;

class LeanRunner {
  constructor() {
    this._binaryPath = null;
    this._available = false;
    this._workDir = path.join(os.tmpdir(), 'fermat-lean');
    if (!fs.existsSync(this._workDir)) {
      fs.mkdirSync(this._workDir, { recursive: true });
    }
  }

  // ─── Binary detection ──────────────────────────────────────────────────────

  /**
   * Detect the lean binary.
   * @param {string} [override] — explicit path from settings (may be empty string)
   * @returns {{ available: boolean, path: string|null, version: string|null }}
   */
  detect(override) {
    const candidates = [
      override,                       // user-specified
      process.env.LEAN,               // env var
      this._which('lean'),            // PATH
      path.join(os.homedir(), '.elan', 'bin', 'lean'),  // default elan location
    ].filter(Boolean);

    for (const candidate of candidates) {
      const result = this._tryBinary(candidate);
      if (result) {
        this._binaryPath = candidate;
        this._available = true;
        console.log(`[LeanRunner] Found lean at ${candidate} (${result})`);
        return { available: true, path: candidate, version: result };
      }
    }

    this._binaryPath = null;
    this._available = false;
    console.warn('[LeanRunner] lean binary not found');
    return { available: false, path: null, version: null };
  }

  get isAvailable() { return this._available; }
  get binaryPath()  { return this._binaryPath; }

  // ─── Verification ─────────────────────────────────────────────────────────

  /**
   * Run lean on a snippet of Lean 4 source code.
   *
   * @param {string} leanSource — complete Lean 4 source (imports + theorem + proof)
   * @param {function} onLine   — called with each output line as it arrives
   * @param {AbortSignal} [signal] — optional cancellation
   * @returns {Promise<{ success: boolean, errors: LeanError[], rawOutput: string }>}
   */
  verify(leanSource, onLine, signal) {
    if (!this._available) {
      return Promise.resolve({
        success: false,
        errors: [{ line: 0, col: 0, severity: 'error', message: 'lean binary not found' }],
        rawOutput: '',
      });
    }

    return new Promise((resolve, reject) => {
      // Write source to a temp file
      const tmpFile = path.join(this._workDir, `verify_${Date.now()}.lean`);
      fs.writeFileSync(tmpFile, leanSource, 'utf-8');

      const env = {
        ...process.env,
        PATH: [
          path.dirname(this._binaryPath),
          path.join(os.homedir(), '.elan', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
          process.env.PATH || '',
        ].join(':'),
      };

      const proc = spawn(this._binaryPath, [tmpFile], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let rawOutput = '';
      const errors = [];

      const handleLine = (line) => {
        rawOutput += line + '\n';
        if (onLine) onLine(line);

        // Rewrite file path in error messages to just the filename (cleaner UI)
        const cleanLine = line.replace(tmpFile, 'theorem.lean');
        const m = cleanLine.match(LEAN_ERROR_RE);
        if (m) {
          errors.push({
            file: m[1],
            line: parseInt(m[2], 10),
            col: parseInt(m[3], 10),
            severity: m[4],
            message: m[5],
          });
        }
      };

      // Buffer partial lines across data chunks
      let outBuf = '';
      let errBuf = '';

      proc.stdout.on('data', (chunk) => {
        outBuf += chunk.toString();
        const lines = outBuf.split('\n');
        outBuf = lines.pop(); // keep incomplete last line
        lines.forEach(handleLine);
      });

      proc.stderr.on('data', (chunk) => {
        errBuf += chunk.toString();
        const lines = errBuf.split('\n');
        errBuf = lines.pop();
        lines.forEach(handleLine);
      });

      // Flush any remaining buffered output on close
      proc.on('close', (code) => {
        if (outBuf) handleLine(outBuf);
        if (errBuf) handleLine(errBuf);
        try { fs.unlinkSync(tmpFile); } catch {}

        const realErrors = errors.filter(e => e.severity === 'error');
        resolve({
          success: code === 0 && realErrors.length === 0,
          exitCode: code,
          errors,
          rawOutput: rawOutput.trim(),
        });
      });

      proc.on('error', (err) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        reject(new Error(`Failed to spawn lean: ${err.message}`));
      });

      // Honour cancellation
      if (signal) {
        signal.addEventListener('abort', () => {
          proc.kill('SIGTERM');
        });
      }
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _which(name) {
    try {
      return execFileSync('which', [name], {
        timeout: 2000, stdio: 'pipe',
        env: {
          ...process.env,
          PATH: [
            path.join(os.homedir(), '.elan', 'bin'),
            '/usr/local/bin',
            '/opt/homebrew/bin',
            process.env.PATH || '',
          ].join(':'),
        },
      }).toString().trim();
    } catch {
      return null;
    }
  }

  _tryBinary(p) {
    if (!p || !fs.existsSync(p)) return null;
    try {
      const out = execFileSync(p, ['--version'], {
        timeout: 5000, stdio: 'pipe',
      }).toString().trim();
      return out || 'unknown version';
    } catch {
      return null;
    }
  }
}

module.exports = { LeanRunner };
