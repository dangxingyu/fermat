/**
 * LeanRunner
 *
 * Manages the local Lean 4 verification environment for Fermat.
 *
 * Three verification modes:
 *
 *   1. REPL mode (useRepl: true + usesMathlib: true + mathlibReady)
 *      Uses a persistent `lake exe repl` process (LeanRepl).  Mathlib is
 *      loaded once at startup; subsequent verifications reuse the warm process.
 *      Eliminates the ~30 s mathlib cold-start cost per verification.
 *
 *   2. Core-only (default)
 *      Writes a temp .lean file to /tmp, runs `lean <file>` directly.
 *      Fast (~1-3 s), no lake project required, supports Lean core + Std.
 *
 *   3. Mathlib binary mode (usesMathlib: true, useRepl: false)
 *      Writes the temp file into lean-workspace/ (the lake project that has
 *      mathlib as a dependency), runs `lake env lean <file>`.  Requires lake
 *      exe cache get to have been run first.
 *
 * Error parsing:
 *   Lean error format:  /path/file.lean:LINE:COL: error: MESSAGE
 *   Parsed into { file, line, col, severity, message } structs.
 */

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Lean error line format:  /path/to/file.lean:LINE:COL: (error|warning|info): MESSAGE
const LEAN_ERROR_RE = /^(.+?):(\d+):(\d+): (error|warning|info): (.+)$/;

/**
 * Parse a single Lean output line into a structured error, or return null.
 * Pure function — exported so it can be unit-tested directly.
 */
function parseLeanErrorLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(LEAN_ERROR_RE);
  if (!m) return null;
  return {
    file: m[1],
    line: parseInt(m[2], 10),
    col:  parseInt(m[3], 10),
    severity: m[4],
    message:  m[5],
  };
}

// B-10: default per-verify timeout. Lean tactics like `decide` or `simp` can
// hang indefinitely on malformed goals; without this a single bad sorry locks
// one slot of the maxConcurrent pool until the app restarts.
const DEFAULT_LEAN_TIMEOUT_MS = 120_000;

// Absolute path to the lean-workspace lake project (relative to Fermat repo root).
// In packaged builds this resolves to resourcesPath/lean-workspace.
function resolveWorkspacePath() {
  const { app } = (() => { try { return require('electron'); } catch { return {}; } })();
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'lean-workspace');
  }
  // In dev: two levels up from src/main/ → repo root → lean-workspace
  return path.join(__dirname, '..', '..', 'lean-workspace');
}

class LeanRunner {
  constructor() {
    this._binaryPath = null;   // lean binary (elan shim or absolute)
    this._available = false;
    this._usesMathlib = false;
    this._useRepl = false;

    // Core-only temp dir
    this._tmpDir = path.join(os.tmpdir(), 'fermat-lean');
    if (!fs.existsSync(this._tmpDir)) {
      fs.mkdirSync(this._tmpDir, { recursive: true });
    }

    // Lake workspace (for mathlib / REPL mode)
    this._workspacePath = resolveWorkspacePath();
    this._mathlibReady = false;
    this._detectMathlibCache();

    // Persistent REPL — created lazily when useRepl + mathlib are both enabled
    this._repl = null;
  }

  // ─── Binary detection ──────────────────────────────────────────────────────

  /**
   * Detect the lean binary asynchronously — does not block the event loop.
   * Callers should fire-and-forget or await; never call synchronously from
   * startup code that runs before the renderer is ready.
   *
   * @param {string} [override] — explicit path from settings (may be empty)
   * @returns {Promise<{ available: boolean, path: string|null, version: string|null,
   *                     replAvailable: boolean, mode: string }>}
   */
  async detect(override) {
    const candidates = (await Promise.all([
      Promise.resolve(override || null),
      Promise.resolve(process.env.LEAN || null),
      this._whichAsync('lean'),
      Promise.resolve(path.join(os.homedir(), '.elan', 'bin', 'lean')),
    ])).filter(Boolean);

    for (const candidate of candidates) {
      const version = await this._tryBinaryAsync(candidate);
      if (version) {
        this._binaryPath = candidate;
        this._available = true;
        console.log(`[LeanRunner] lean found at ${candidate} (${version.split('\n')[0]})`);
        return { available: true, path: candidate, version,
                 replAvailable: this._repl?.isReady ?? false, mode: this.mode };
      }
    }

    this._binaryPath = null;
    this._available = false;
    console.warn('[LeanRunner] lean binary not found');
    return { available: false, path: null, version: null,
             replAvailable: false, mode: 'binary' };
  }

  /**
   * Set whether to use the mathlib lake workspace for verification.
   * Also manages REPL lifecycle when useRepl is enabled.
   */
  setUsesMathlib(flag) {
    this._usesMathlib = !!flag;
    if (flag) {
      this._detectMathlibCache();
      if (this._useRepl && this._mathlibReady) this._ensureRepl();
    } else {
      this._stopRepl();
    }
  }

  /**
   * Enable or disable the persistent REPL for mathlib verification.
   * When enabled and mathlib is ready, the REPL starts asynchronously.
   */
  setUseRepl(flag) {
    this._useRepl = !!flag;
    if (this._useRepl && this._usesMathlib && this._mathlibReady) {
      this._ensureRepl();
    } else if (!this._useRepl) {
      this._stopRepl();
    }
  }

  get isAvailable()    { return this._available; }
  get binaryPath()     { return this._binaryPath; }
  get mathlibReady()   { return this._mathlibReady; }
  /** 'repl' when the REPL is active, 'binary' otherwise. */
  get mode() {
    const useMathlib = this._usesMathlib && this._mathlibReady;
    return (this._useRepl && useMathlib && this._repl?.isReady) ? 'repl' : 'binary';
  }

  // ─── Verification ─────────────────────────────────────────────────────────

  /**
   * Like verify(), but also returns `sorryWarnings` — the subset of warnings
   * that indicate a `sorry` was used (i.e. the proof is incomplete).
   *
   * Lean 4 warning format for sorry:  "declaration uses 'sorry'"
   *
   * @returns {Promise<{ success, errors, rawOutput, sorryWarnings: LeanError[] }>}
   */
  async verifySorries(leanSource, onLine, signal) {
    const result = await this.verify(leanSource, onLine, signal);
    const sorryWarnings = result.errors.filter(
      e => e.severity === 'warning' && e.message.includes("'sorry'"),
    );
    return { ...result, sorryWarnings };
  }

  /**
   * Run lean on a snippet of Lean 4 source code.
   *
   * When usesMathlib is true and mathlibReady, writes the file inside the
   * lean-workspace lake project so that `import Mathlib` resolves correctly.
   *
   * @param {string} leanSource — complete Lean 4 source
   * @param {function} onLine   — called with each output line as it arrives
   * @param {AbortSignal} [signal] — optional cancellation
   * @returns {Promise<{ success: boolean, errors: LeanError[], rawOutput: string }>}
   */
  verify(leanSource, onLine, signal) {
    if (!this._available) {
      return Promise.resolve({
        success: false,
        errors: [{ line: 0, col: 0, severity: 'error', message: 'lean binary not found — check Settings' }],
        rawOutput: '',
      });
    }

    const useMathlib = this._usesMathlib && this._mathlibReady;

    // REPL path: persistent process with Mathlib loaded once — avoids cold starts
    if (this._useRepl && useMathlib && this._repl?.isReady) {
      return this._repl.verify(leanSource, onLine, signal);
    }

    return useMathlib
      ? this._verifyWithMathlib(leanSource, onLine, signal)
      : this._verifyCoreOnly(leanSource, onLine, signal);
  }

  // ─── Core-only verification ───────────────────────────────────────────────

  _verifyCoreOnly(leanSource, onLine, signal) {
    const tmpFile = path.join(this._tmpDir, `verify_${Date.now()}.lean`);
    fs.writeFileSync(tmpFile, leanSource, 'utf-8');

    const env = this._buildEnv();
    return this._runLean(this._binaryPath, [tmpFile], env, undefined /* cwd */, tmpFile, onLine, signal);
  }

  // ─── Mathlib verification ─────────────────────────────────────────────────
  // Uses `lake env lean <file>` so that the lake project injects the correct
  // LEAN_PATH entries for mathlib into the lean process environment.
  // The temp file is placed inside the lake project root.

  _verifyWithMathlib(leanSource, onLine, signal) {
    // Resolve the `lake` binary — it lives next to lean in elan's bin dir.
    const lakeBin = this._resolveLakeBin();
    if (!lakeBin) {
      // Fall back to core-only if lake isn't found
      console.warn('[LeanRunner] lake not found, falling back to core-only verification');
      return this._verifyCoreOnly(leanSource, onLine, signal);
    }

    // B-02: write to a *unique* filename so concurrent verifications
    // (the sketch→fill→sorrify pipeline runs several) don't clobber each other.
    // The file must be a Lean-valid module name: letters, digits, underscores.
    const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpName = `_FermatVerify_${uniq}.lean`;
    const tmpFile = path.join(this._workspacePath, tmpName);
    fs.writeFileSync(tmpFile, leanSource, 'utf-8');

    const env = this._buildEnv();
    // `lake env lean <file>` — lake sets up LEAN_PATH then execs lean
    return this._runLean(
      lakeBin,
      ['env', 'lean', tmpName],
      env,
      this._workspacePath,  // cwd must be the lake project root
      tmpFile,
      onLine,
      signal,
    );
  }

  // ─── Core runner ─────────────────────────────────────────────────────────

  _runLean(binary, args, env, cwd, tmpFile, onLine, signal, timeoutMs = DEFAULT_LEAN_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args, {
        env,
        cwd: cwd || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let rawOutput = '';
      const errors = [];
      let timedOut = false;

      // B-10: enforce a hard timeout so hung `decide`/`simp` calls release
      // the concurrency slot instead of locking the pool forever.
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            console.warn(`[LeanRunner] Timeout (${timeoutMs}ms) — killing lean process`);
            try { proc.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500);
          }, timeoutMs)
        : null;

      const handleLine = (line) => {
        rawOutput += line + '\n';
        if (onLine) onLine(line);

        // Normalise file path in error messages for cleaner UI
        const cleanLine = line
          .replace(tmpFile, 'theorem.lean')
          .replace(this._workspacePath + path.sep, '');
        const parsed = parseLeanErrorLine(cleanLine);
        if (parsed) errors.push(parsed);
      };

      let outBuf = '';
      let errBuf = '';

      proc.stdout.on('data', (chunk) => {
        outBuf += chunk.toString();
        const lines = outBuf.split('\n');
        outBuf = lines.pop();
        lines.forEach(handleLine);
      });

      proc.stderr.on('data', (chunk) => {
        errBuf += chunk.toString();
        const lines = errBuf.split('\n');
        errBuf = lines.pop();
        lines.forEach(handleLine);
      });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (outBuf) handleLine(outBuf);
        if (errBuf) handleLine(errBuf);
        // Clean up temp file (ignore errors — file may already be gone)
        try { if (tmpFile) fs.unlinkSync(tmpFile); } catch {}

        if (timedOut) {
          errors.push({
            file: tmpFile, line: 0, col: 0, severity: 'error',
            message: `lean timed out after ${timeoutMs}ms and was killed`,
          });
        }
        const realErrors = errors.filter(e => e.severity === 'error');
        resolve({
          success: !timedOut && code === 0 && realErrors.length === 0,
          exitCode: code,
          errors,
          rawOutput: rawOutput.trim(),
          usedMathlib: this._usesMathlib && this._mathlibReady,
          timedOut,
        });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        try { if (tmpFile) fs.unlinkSync(tmpFile); } catch {}
        reject(new Error(`Failed to spawn lean: ${err.message}`));
      });

      if (signal) {
        const onAbort = () => {
          try { proc.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // ─── REPL lifecycle ───────────────────────────────────────────────────────

  _ensureRepl() {
    if (this._repl?.isReady || this._repl?._startPromise) return;
    const { LeanRepl } = require('./lean-repl');
    this._repl = new LeanRepl(this._workspacePath, {
      lakeBin:       this._resolveLakeBin(),
      usesMathlib:   true,
    });
    this._repl.start().catch(err => {
      console.error('[LeanRunner] REPL start failed:', err.message);
    });
  }

  _stopRepl() {
    if (!this._repl) return;
    this._repl.stop().catch(() => {});
    this._repl = null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _buildEnv() {
    return {
      ...process.env,
      PATH: [
        this._binaryPath ? path.dirname(this._binaryPath) : '',
        path.join(os.homedir(), '.elan', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        process.env.PATH || '',
      ].filter(Boolean).join(':'),
    };
  }

  /**
   * Resolve the `lake` binary.
   * lake lives next to lean in elan's bin directory.
   */
  _resolveLakeBin() {
    const candidates = [
      this._which('lake'),
      path.join(os.homedir(), '.elan', 'bin', 'lake'),
      this._binaryPath ? path.join(path.dirname(this._binaryPath), 'lake') : null,
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Check whether the mathlib olean cache has been downloaded.
   * B-07: previously only checked the directory existed, which returned true
   * even for a partial or failed checkout. Now look for at least one .olean
   * file to confirm the cache is actually built.
   */
  _detectMathlibCache() {
    const cacheDir = path.join(this._workspacePath, '.lake', 'packages', 'mathlib');
    this._mathlibReady = fs.existsSync(cacheDir) && this._hasAnyOlean(cacheDir);
    if (this._mathlibReady) {
      console.log('[LeanRunner] Mathlib workspace detected at', this._workspacePath);
    }
  }

  /**
   * Walk `dir` looking for any .olean file. Stops as soon as one is found so
   * this is cheap even on deep trees. Bounded by `maxEntries` to avoid
   * walking the entire cache if none are present.
   */
  _hasAnyOlean(dir, maxEntries = 5000) {
    const stack = [dir];
    let seen = 0;
    while (stack.length && seen < maxEntries) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        seen++;
        if (seen >= maxEntries) return false;
        if (e.isFile() && e.name.endsWith('.olean')) return true;
        if (e.isDirectory()) stack.push(path.join(d, e.name));
      }
    }
    return false;
  }

  _whichAsync(name) {
    const env = {
      ...process.env,
      PATH: [
        path.join(os.homedir(), '.elan', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        process.env.PATH || '',
      ].join(':'),
    };
    return new Promise(resolve => {
      const t = setTimeout(() => { proc.kill('SIGTERM'); resolve(null); }, 2000);
      const proc = execFile('which', [name], { env, stdio: 'pipe' }, (err, stdout) => {
        clearTimeout(t);
        resolve(err ? null : (stdout.trim() || null));
      });
    });
  }

  _tryBinaryAsync(p) {
    if (!p || !fs.existsSync(p)) return Promise.resolve(null);
    return new Promise(resolve => {
      const t = setTimeout(() => { proc.kill('SIGTERM'); resolve(null); }, 5000);
      const proc = execFile(p, ['--version'], { stdio: 'pipe' }, (err, stdout) => {
        clearTimeout(t);
        resolve(err ? null : (stdout.trim() || 'unknown version'));
      });
    });
  }

  // Synchronous variants kept for internal use in _resolveLakeBin and tests.
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
      }).toString().trim() || null;
    } catch {
      return null;
    }
  }

  _tryBinary(p) {
    if (!p || !fs.existsSync(p)) return null;
    try {
      return execFileSync(p, ['--version'], {
        timeout: 5000, stdio: 'pipe',
      }).toString().trim() || 'unknown version';
    } catch {
      return null;
    }
  }
}

module.exports = { LeanRunner, parseLeanErrorLine };
