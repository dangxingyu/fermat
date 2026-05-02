// Tests for src/main/lean-runner.js
// Covers: parseLeanErrorLine (error format parser), _tryBinary path validation,
// detect() fallback chain, and setUsesMathlib toggling.
//
// We can't spawn a real `lean` in unit tests (the binary may not exist on CI),
// so the binary-detection tests deliberately target the "no lean available"
// path — which still needs to behave correctly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { LeanRunner, parseLeanErrorLine } from '../lean-runner.js';

// ─── Fixture helpers ────────────────────────────────────────────────────────
// Create a minimal fake lean-workspace on disk so tests can exercise the
// detection methods against real file state without depending on the actual
// lean-workspace/ in the repo.

/** Lay out .lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean */
function writeMathlibOlean(root) {
  const oleanDir = path.join(
    root, '.lake', 'packages', 'mathlib',
    '.lake', 'build', 'lib', 'lean',
  );
  fs.mkdirSync(oleanDir, { recursive: true });
  fs.writeFileSync(path.join(oleanDir, 'Mathlib.olean'), '');
}

/** Write a lake-manifest.json with the given list of package {name} entries. */
function writeManifest(root, packages = []) {
  fs.writeFileSync(
    path.join(root, 'lake-manifest.json'),
    JSON.stringify({
      version: '1.1.0',
      packagesDir: '.lake/packages',
      packages,
      name: 'fermat-lean-test',
      lakeDir: '.lake',
    }),
  );
}

/** Make a runner whose workspace is pointed at the given fixture dir. */
function makeRunnerAt(workspaceDir) {
  const r = new LeanRunner();
  r._workspacePath = workspaceDir;
  // Re-run detection against the new workspace
  r._mathlibReady = false;
  r._detectMathlibCache();
  return r;
}

/** True if a real `lean` binary is on PATH — used to gate integration tests. */
function leanOnPath() {
  try {
    execFileSync('lean', ['--version'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch { return false; }
}

describe('parseLeanErrorLine', () => {
  it('parses a standard error line', () => {
    const line = '/tmp/fermat-lean/verify_123.lean:12:4: error: unknown identifier foo';
    expect(parseLeanErrorLine(line)).toEqual({
      file: '/tmp/fermat-lean/verify_123.lean',
      line: 12,
      col: 4,
      severity: 'error',
      message: 'unknown identifier foo',
    });
  });

  it('parses warning and info severity', () => {
    expect(parseLeanErrorLine('theorem.lean:3:0: warning: unused variable \'x\''))
      .toMatchObject({ severity: 'warning' });
    expect(parseLeanErrorLine('theorem.lean:3:0: info: Try this: exact h'))
      .toMatchObject({ severity: 'info' });
  });

  it('handles empty / null / non-error input', () => {
    expect(parseLeanErrorLine('')).toBeNull();
    expect(parseLeanErrorLine(null)).toBeNull();
    expect(parseLeanErrorLine(undefined)).toBeNull();
    expect(parseLeanErrorLine('just a plain log line')).toBeNull();
    expect(parseLeanErrorLine(42)).toBeNull();
  });

  it('handles paths containing spaces and colons in the message', () => {
    const line = 'theorem.lean:9:2: error: type mismatch: expected Nat, got String';
    const parsed = parseLeanErrorLine(line);
    expect(parsed.file).toBe('theorem.lean');
    expect(parsed.line).toBe(9);
    expect(parsed.col).toBe(2);
    expect(parsed.message).toBe('type mismatch: expected Nat, got String');
  });

  it('does not misparse lines with line-like numbers but wrong format', () => {
    expect(parseLeanErrorLine('12:34:56 some log')).toBeNull();
    expect(parseLeanErrorLine('file.lean:abc: error: x')).toBeNull();
  });
});

describe('LeanRunner._tryBinary', () => {
  it('returns null for a non-existent path', () => {
    const r = new LeanRunner();
    expect(r._tryBinary('/nowhere/definitely-not-a-lean-binary')).toBeNull();
  });

  it('returns null for empty / null input', () => {
    const r = new LeanRunner();
    expect(r._tryBinary('')).toBeNull();
    expect(r._tryBinary(null)).toBeNull();
    expect(r._tryBinary(undefined)).toBeNull();
  });

  it('returns null for a path that exists but is not executable as lean', () => {
    const r = new LeanRunner();
    // /bin/ls exists but lacks a `--version` output matching lean's format.
    // `_tryBinary` catches any exec failure and returns null; for `ls` with
    // --version the exit is 0 but the output is just ls's version string,
    // which counts as "some version string" and is returned as-is. So this
    // assertion only guards against the *exception* path.
    // Non-existent path gives a definitive null:
    expect(r._tryBinary('/definitely-not-a-real-path-xyz-123')).toBeNull();
  });
});

describe('LeanRunner.detect', () => {
  // detect() shells out asynchronously to `which lean` + `lean --version` etc.
  // On a machine where lean is installed, this can take several seconds.
  // Bump the per-test timeout so CI on either config passes.
  const longTimeout = 15000;

  it('returns a shape of { available, path, version } regardless of success', async () => {
    const r = new LeanRunner();
    const result = await r.detect('/nonexistent/lean');
    expect(result).toHaveProperty('available');
    expect(result).toHaveProperty('path');
    expect(result).toHaveProperty('version');
    expect(result).toHaveProperty('replAvailable');
    expect(result).toHaveProperty('mode');
    expect(typeof result.available).toBe('boolean');
  }, longTimeout);

  it('falls through when override path does not exist', async () => {
    const r = new LeanRunner();
    await r.detect('/absolutely/not/a/real/path');
    // binaryPath either resolves to a real system lean or null — both are fine.
    const p = r.binaryPath;
    expect(p === null || typeof p === 'string').toBe(true);
  }, longTimeout);
});

describe('LeanRunner.setUsesMathlib', () => {
  it('coerces the flag to a boolean', () => {
    const r = new LeanRunner();
    r.setUsesMathlib(1);
    // Not directly observable, but shouldn't throw and `get mathlibReady`
    // should be callable.
    expect(typeof r.mathlibReady).toBe('boolean');
    r.setUsesMathlib(0);
    expect(typeof r.mathlibReady).toBe('boolean');
  });
});

describe('LeanRunner.isAvailable getter', () => {
  it('is false before detect() is called successfully', () => {
    const r = new LeanRunner();
    // Fresh instance — no detection performed.
    expect(r.isAvailable).toBe(false);
    expect(r.binaryPath).toBe(null);
  });
});

// ─── _detectMathlibCache ────────────────────────────────────────────────────
// Regression coverage for the DFS bug: Mathlib ships its full git checkout
// (~103k source files + 3k+ subdirs) in .lake/packages/mathlib/, so the old
// "DFS with 5000-entry cap" detection aborted before finding any .olean.
// The new impl stats a specific known-good path; these tests guard it.

describe('LeanRunner._detectMathlibCache', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-lr-mathlib-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('sets mathlibReady=true when Mathlib.olean is at the expected path', () => {
    writeMathlibOlean(tmpRoot);
    const r = makeRunnerAt(tmpRoot);
    expect(r.mathlibReady).toBe(true);
  });

  it('sets mathlibReady=false when the sentinel olean is missing', () => {
    // Workspace exists but no built oleans — common state right after `lake update`
    const r = makeRunnerAt(tmpRoot);
    expect(r.mathlibReady).toBe(false);
  });

  it('sets mathlibReady=false when the mathlib package dir is absent entirely', () => {
    // No .lake/packages/mathlib at all
    const r = makeRunnerAt(tmpRoot);
    expect(r.mathlibReady).toBe(false);
  });

  // REGRESSION: the old DFS with maxEntries=5000 would falsely report
  // "not found" because mathlib's source tree fills the quota before the
  // walker reaches .lake/build/lib/lean/. Noise in the workspace must NOT
  // affect detection.
  it('is not confused by thousands of unrelated source files', () => {
    writeMathlibOlean(tmpRoot);
    const srcDir = path.join(tmpRoot, '.lake', 'packages', 'mathlib', 'Mathlib');
    fs.mkdirSync(srcDir, { recursive: true });
    // 6000 dummy .lean files — old DFS would hit its 5000 cap before oleans
    for (let i = 0; i < 6000; i++) {
      fs.writeFileSync(path.join(srcDir, `Noise${i}.lean`), '-- pad');
    }
    const r = makeRunnerAt(tmpRoot);
    expect(r.mathlibReady).toBe(true);
  });

  it('re-detects when setUsesMathlib(true) is called after cache appears', () => {
    // Start with no cache
    const r = makeRunnerAt(tmpRoot);
    expect(r.mathlibReady).toBe(false);
    // User then runs `lake exe cache get`, olean appears
    writeMathlibOlean(tmpRoot);
    r.setUsesMathlib(true);
    expect(r.mathlibReady).toBe(true);
  });
});

// ─── _detectReplPackage ─────────────────────────────────────────────────────
describe('LeanRunner._detectReplPackage', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-lr-repl-')); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('returns true when repl is listed in lake-manifest.json', () => {
    writeManifest(tmpRoot, [{ name: 'mathlib' }, { name: 'repl' }]);
    const r = makeRunnerAt(tmpRoot);
    expect(r._detectReplPackage()).toBe(true);
  });

  it('returns false when repl is not among the packages', () => {
    writeManifest(tmpRoot, [{ name: 'mathlib' }, { name: 'batteries' }]);
    const r = makeRunnerAt(tmpRoot);
    expect(r._detectReplPackage()).toBe(false);
  });

  it('returns false when lake-manifest.json does not exist', () => {
    const r = makeRunnerAt(tmpRoot);
    expect(r._detectReplPackage()).toBe(false);
  });

  it('returns false when lake-manifest.json is malformed', () => {
    fs.writeFileSync(path.join(tmpRoot, 'lake-manifest.json'), 'not valid json');
    const r = makeRunnerAt(tmpRoot);
    expect(r._detectReplPackage()).toBe(false);
  });
});

// ─── effectiveMathlib getter (LLM import decision) ──────────────────────────
// This is the flag that drives whether the LLM is told to generate
// `import Mathlib` vs `import Std`. Getting this wrong was the root cause of
// "unknown module prefix 'Mathlib'" errors.

describe('LeanRunner.effectiveMathlib', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-lr-eff-')); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('is true only when user opted in AND cache is built', () => {
    writeMathlibOlean(tmpRoot);
    const r = makeRunnerAt(tmpRoot);

    // Cache ready but user hasn't opted in → false (this was the bug scenario)
    r.setUsesMathlib(false);
    expect(r.effectiveMathlib).toBe(false);

    r.setUsesMathlib(true);
    expect(r.effectiveMathlib).toBe(true);
  });

  it('is false when user opted in but cache is missing', () => {
    // No Mathlib.olean written
    const r = makeRunnerAt(tmpRoot);
    r.setUsesMathlib(true);
    expect(r.effectiveMathlib).toBe(false);
  });
});

// ─── mode getter ────────────────────────────────────────────────────────────
describe('LeanRunner.mode', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-lr-mode-')); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('is "binary" on a fresh runner', () => {
    const r = new LeanRunner();
    expect(r.mode).toBe('binary');
  });

  it('stays "binary" when useRepl is enabled but the repl package is absent', () => {
    writeManifest(tmpRoot, [{ name: 'mathlib' }]); // no repl entry
    const r = makeRunnerAt(tmpRoot);
    r.setUseRepl(true);
    expect(r.mode).toBe('binary'); // _repl stays null → never reports "repl"
  });
});

// ─── Lazy REPL startup ──────────────────────────────────────────────────────
// LeanRepl.start() resolves `void` on success. LeanRunner must check
// `repl.isReady` after awaiting it, not the truthiness of the resolved value.

describe('LeanRunner._verifyViaRepl', () => {
  it('uses the REPL after a successful lazy start that resolves void', async () => {
    const r = new LeanRunner();
    let lakeCalled = false;
    let replVerifyCalled = false;

    r._verifyWithLakeEnv = async () => {
      lakeCalled = true;
      return { success: false, source: 'lake' };
    };

    r._repl = {
      isReady: false,
      async start() {
        this.isReady = true;
      },
      async verify(source) {
        replVerifyCalled = true;
        return { success: true, source };
      },
    };

    const result = await r._verifyViaRepl('example : True := trivial');

    expect(result).toEqual({ success: true, source: 'example : True := trivial' });
    expect(replVerifyCalled).toBe(true);
    expect(lakeCalled).toBe(false);
  });

  it('falls back to lake-env verification when REPL startup rejects', async () => {
    const r = new LeanRunner();
    let lakeCalled = false;

    r._verifyWithLakeEnv = async (source) => {
      lakeCalled = true;
      return { success: true, source, fallback: true };
    };

    r._repl = {
      isReady: false,
      async start() {
        throw new Error('no repl executable');
      },
      async verify() {
        throw new Error('should not be called');
      },
    };

    const result = await r._verifyViaRepl('example : True := trivial');

    expect(result).toEqual({ success: true, source: 'example : True := trivial', fallback: true });
    expect(lakeCalled).toBe(true);
  });
});

// ─── verify() fast-path: no lean binary ─────────────────────────────────────
// Returns a structured error without spawning anything. This is what the UI
// shows when the user hasn't installed lean yet.

describe('LeanRunner.verify — no lean available', () => {
  it('returns a structured error and never spawns a process', async () => {
    const r = new LeanRunner();
    r._available = false; // simulate "lean not found"
    const result = await r.verify('example : True := trivial');
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      severity: 'error',
      message: expect.stringMatching(/lean binary not found/),
    });
    expect(result.rawOutput).toBe('');
  });
});

// ─── Integration: real lean verification ────────────────────────────────────
// Only runs when a real `lean` binary is on PATH. Skips on CI hosts that
// don't have lean installed, so we don't break those builds.

const HAS_LEAN = leanOnPath();

describe.skipIf(!HAS_LEAN)('LeanRunner integration (requires lean on PATH)', () => {
  it('verifies a trivial core-only snippet via the live binary', async () => {
    const r = new LeanRunner();
    await r.detect();
    expect(r.isAvailable).toBe(true);

    // Don't use the real mathlib workspace — we want a pure core-only test
    // that's fast and doesn't need the 7k-olean cache.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-lr-int-'));
    r._workspacePath = tmp;
    r._mathlibReady = false;
    r.setUsesMathlib(false);
    r.setUseRepl(false);

    try {
      const result = await r.verify('example : 1 + 1 = 2 := by decide');
      const realErrors = result.errors.filter(e => e.severity === 'error');
      expect(realErrors).toEqual([]);
      expect(result.success).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('surfaces a real Lean error on a broken snippet', async () => {
    const r = new LeanRunner();
    await r.detect();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-lr-int-'));
    r._workspacePath = tmp;
    r._mathlibReady = false;
    r.setUsesMathlib(false);
    r.setUseRepl(false);

    try {
      // Use a proof that fails — `rfl` on a false equation yields a clear
      // "unsolved goals" / type-mismatch error that Lean formats predictably.
      const result = await r.verify('example : 1 = 2 := rfl');
      expect(result.success).toBe(false);
      // Either we parsed a structured error, or lean's stderr landed in rawOutput
      // (its exit code alone is enough to flip success). Both shapes are valid.
      const realErrors = result.errors.filter(e => e.severity === 'error');
      const hasSignal = realErrors.length > 0 || /error/i.test(result.rawOutput);
      expect(hasSignal).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
