/**
 * LeanRunner
 *
 * Manages the local Lean 4 verification environment for Fermat.
 *
 * Verification flow (preference order):
 *
 *   1. REPL mode — `useRepl: true` AND repl package is built in the workspace.
 *      A persistent `lake exe repl` process stays alive; Mathlib is loaded
 *      once at startup (~30 s), then each subsequent verify is 1–3 s.
 *
 *   2. Lake env mode (default when lake is installed).
 *      `lake env lean <file>` inside lean-workspace/. Lake sets up LEAN_PATH
 *      so `import Mathlib`, `import Std`, or any declared dependency resolves.
 *      This is the single path for both "Mathlib" and "no-Mathlib" code; the
 *      `_usesMathlib` flag ONLY controls what the LLM generates (see
 *      `effectiveMathlib` getter), never which command we run.
 *
 *   3. Core-only fallback — used only when lake is not installed. Runs
 *      `lean <file>` from /tmp with no workspace context. Supports Lean core
 *      + Std proofs; `import Mathlib` will fail with "unknown module prefix".
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
// In packaged builds, seed a writable copy from resourcesPath into userData.
// Lake writes .lake/packages and .lake/build artifacts during setup, and app
// resources are read-only on some platforms.
function syncPackagedWorkspace(bundledPath, userWorkspacePath) {
  if (!fs.existsSync(bundledPath)) return false;

  fs.mkdirSync(userWorkspacePath, { recursive: true });
  fs.cpSync(bundledPath, userWorkspacePath, {
    recursive: true,
    force: true,
    filter: (src) => !path.relative(bundledPath, src).split(path.sep).includes('.lake'),
  });
  return true;
}

function hasWorkspaceSeed(workspacePath) {
  return fs.existsSync(path.join(workspacePath, 'lakefile.toml'))
    && fs.existsSync(path.join(workspacePath, 'lean-toolchain'));
}

function resolveWorkspacePath() {
  const { app } = (() => { try { return require('electron'); } catch { return {}; } })();
  if (app?.isPackaged) {
    const bundledPath = path.join(process.resourcesPath, 'lean-workspace');
    let userWorkspacePath = bundledPath;
    try {
      userWorkspacePath = path.join(app.getPath('userData'), 'lean-workspace');
      if (syncPackagedWorkspace(bundledPath, userWorkspacePath)) {
        return userWorkspacePath;
      }
    } catch (err) {
      console.warn('[LeanRunner] Failed to sync packaged lean-workspace:', err.message);
    }
    return hasWorkspaceSeed(userWorkspacePath) ? userWorkspacePath : bundledPath;
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

    console.log(`[LeanRunner] Workspace: ${this._workspacePath} | mathlib: ${this._mathlibReady ? 'ready' : 'not found'}`);
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
   * Tells the LLM whether to emit `import Mathlib` (true) or `import Std` (false).
   * Does NOT affect which command we run — verify() always uses `lake env lean`.
   * Recreates the REPL if it was loaded with a different mathlib setting.
   */
  setUsesMathlib(flag) {
    const changed = this._usesMathlib !== !!flag;
    this._usesMathlib = !!flag;
    if (flag) {
      this._detectMathlibCache();
      console.log(`[LeanRunner] LLM will use import Mathlib | cache=${this._mathlibReady ? 'ready' : 'not found'}`);
    } else {
      console.log('[LeanRunner] LLM will use import Std (core-only)');
    }
    // If the REPL is already created with the wrong mathlib flag, recreate it
    if (changed && this._useRepl && this._repl) {
      this._stopRepl();
      this._ensureRepl();
    }
  }

  /**
   * Enable or disable the persistent REPL. Independent of mathlib — the REPL
   * works for both mathlib and core-only code. Creates the LeanRepl instance
   * eagerly; the actual process starts lazily on first verify() call.
   */
  setUseRepl(flag) {
    this._useRepl = !!flag;
    if (this._useRepl) {
      console.log('[LeanRunner] REPL mode: on (process will start on first verify)');
      this._ensureRepl();
    } else {
      if (this._repl) console.log('[LeanRunner] REPL mode: off — stopping persistent process');
      this._stopRepl();
    }
  }

  get isAvailable()    { return this._available; }
  get binaryPath()     { return this._binaryPath; }
  get mathlibReady()   { return this._mathlibReady; }
  /**
   * True when it's safe to tell the LLM to generate `import Mathlib`:
   * the user has opted in AND the olean cache is built. If either is false,
   * fall back to `import Std`. (verify() itself always uses `lake env lean`
   * regardless — this getter only controls what the LLM writes.)
   */
  get effectiveMathlib() { return this._usesMathlib && this._mathlibReady; }
  /** 'repl' when the persistent REPL process is live, 'binary' otherwise. */
  get mode() {
    return (this._useRepl && this._repl?.isReady) ? 'repl' : 'binary';
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
   * Single unified path: always `lake env lean <file>` inside the workspace
   * when lake is available — this handles both Mathlib and core-only code
   * correctly (lake just sets up LEAN_PATH; the code decides what to import).
   * Falls back to direct `lean <file>` only when lake isn't installed.
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

    // REPL path: persistent process with a warm env — starts lazily on first call.
    // Requires useRepl + a LeanRepl instance (created when the repl package is
    // present in lake-manifest and the user opted in via setUseRepl).
    if (this._useRepl && this._repl) {
      return this._verifyViaRepl(leanSource, onLine, signal);
    }

    return this._verifyWithLakeEnv(leanSource, onLine, signal);
  }

  /**
   * Lazy-start the REPL on first verify, then route through it. Falls back to
   * the lake-env path if the REPL fails to start (e.g. repl binary not built).
   */
  async _verifyViaRepl(leanSource, onLine, signal) {
    if (!this._repl.isReady) {
      try {
        await this._repl.start();
      } catch (err) {
        console.warn('[LeanRunner] REPL start failed — falling back to lake env for this call:', err.message);
        return this._verifyWithLakeEnv(leanSource, onLine, signal);
      }
      if (!this._repl.isReady) {
        console.warn('[LeanRunner] REPL start failed — falling back to lake env for this call');
        return this._verifyWithLakeEnv(leanSource, onLine, signal);
      }
    }
    return this._repl.verify(leanSource, onLine, signal);
  }

  // ─── Core-only fallback ──────────────────────────────────────────────────
  // Used ONLY when lake isn't installed. Can't resolve `import Mathlib`.

  _verifyCoreOnly(leanSource, onLine, signal) {
    const tmpFile = path.join(this._tmpDir, `verify_${Date.now()}.lean`);
    fs.writeFileSync(tmpFile, leanSource, 'utf-8');

    const env = this._buildEnv();
    return this._runLean(this._binaryPath, [tmpFile], env, undefined /* cwd */, tmpFile, onLine, signal);
  }

  // ─── Lake-env verification (default when lake is installed) ──────────────
  // Uses `lake env lean <file>` so LEAN_PATH includes every package declared
  // in the workspace's lakefile (Mathlib, Std, etc.). The temp file is placed
  // inside the lake project root so lake treats it as an in-project module.

  _verifyWithLakeEnv(leanSource, onLine, signal) {
    // Resolve the `lake` binary — it lives next to lean in elan's bin dir.
    const lakeBin = this._resolveLakeBin();
    if (!lakeBin) {
      // Only hit when `lake` isn't installed at all. Core-only can't resolve
      // `import Mathlib`, but there's nothing better to try here.
      console.warn('[LeanRunner] lake not found — falling back to core-only (import Mathlib will fail)');
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

  /**
   * Check if the `repl` package is present in lake-manifest.json. Returns
   * true only when the user has actually `lake update`d with `require repl`
   * in their lakefile — otherwise `lake exe repl` would fail to resolve.
   * Missing or malformed manifest counts as absent.
   */
  _detectReplPackage() {
    const manifestPath = path.join(this._workspacePath, 'lake-manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      return Array.isArray(manifest.packages)
        && manifest.packages.some(p => p?.name === 'repl');
    } catch {
      return false;
    }
  }

  /**
   * Create the LeanRepl instance (but do NOT start the process — that happens
   * lazily on the first verify() call via _verifyViaRepl). No-op if:
   *   - the repl package isn't in lake-manifest (lake exe repl would fail), or
   *   - an instance already exists.
   */
  _ensureRepl() {
    if (this._repl) return;
    if (!this._detectReplPackage()) {
      console.warn('[LeanRunner] REPL requested but `repl` package not in lake-manifest — run `lake update` in the workspace');
      return;
    }
    const lakeBin = this._resolveLakeBin();
    if (!lakeBin) {
      console.warn('[LeanRunner] REPL requested but `lake` binary not found');
      return;
    }
    const { LeanRepl } = require('./lean-repl');
    this._repl = new LeanRepl(this._workspacePath, {
      lakeBin,
      usesMathlib: this._usesMathlib && this._mathlibReady,
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
   * Check whether the Mathlib olean cache has been built.
   *
   * Previously walked the mathlib directory looking for any .olean file with
   * a 5000-entry cap, but mathlib ships a full git checkout (~103k source
   * files + 3.4k subdirs) — the cap was hit long before the DFS found the
   * build output, making detection spuriously return false. Instead we
   * directly stat the top-level Mathlib.olean, which only exists once lake
   * has finished building (either via `lake exe cache get` or `lake build`).
   */
  _detectMathlibCache() {
    const mathlibOlean = path.join(
      this._workspacePath, '.lake', 'packages', 'mathlib',
      '.lake', 'build', 'lib', 'lean', 'Mathlib.olean',
    );
    this._mathlibReady = fs.existsSync(mathlibOlean);
    if (this._mathlibReady) {
      console.log('[LeanRunner] Mathlib olean cache found:', mathlibOlean);
    } else {
      console.log('[LeanRunner] Mathlib olean cache NOT built — run `lake exe cache get` in', this._workspacePath);
    }
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
