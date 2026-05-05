// Tests for src/main/lean-repl.js
//
// We can't spawn a real `lake exe repl` in unit tests, so these tests
// exercise the pure logic paths:
//   - _responseToResult()  — REPL JSON → verify result conversion
//   - _prepareSource()     — import line stripping
//   - constructor state    — isReady, _baseEnv defaults
//   - stop()               — safe to call on an unstarted instance
//   - _buildPathStr()      — returns a non-empty string
//
// Protocol integration (the stdin/stdout JSON handshake) is covered by
// manual / E2E tests that require a real lake + mathlib installation.

import { describe, it, expect } from 'vitest';
import { LeanRepl } from '../lean-repl.js';

const WORKSPACE = '/tmp/fake-workspace';

describe('LeanRepl — constructor state', () => {
  it('starts with isReady === false', () => {
    const r = new LeanRepl(WORKSPACE);
    expect(r.isReady).toBe(false);
  });

  it('_baseEnv is null before start()', () => {
    const r = new LeanRepl(WORKSPACE);
    expect(r._baseEnv).toBeNull();
  });

  it('_stopped is false initially', () => {
    const r = new LeanRepl(WORKSPACE);
    expect(r._stopped).toBe(false);
  });

  it('respects usesMathlib option', () => {
    const r = new LeanRepl(WORKSPACE, { usesMathlib: false });
    expect(r._usesMathlib).toBe(false);
  });
});

describe('LeanRepl._prepareSource', () => {
  const r = new LeanRepl(WORKSPACE);

  it('strips import lines', () => {
    const src = 'import Mathlib\n\ntheorem foo : 1 = 1 := rfl';
    expect(r._prepareSource(src)).toBe('theorem foo : 1 = 1 := rfl');
  });

  it('strips multiple import lines', () => {
    const src = 'import Mathlib\nimport Std\n\ndef x := 1';
    expect(r._prepareSource(src)).toBe('def x := 1');
  });

  it('preserves non-import lines', () => {
    const src = '-- no imports\ntheorem bar : 2 = 2 := rfl';
    expect(r._prepareSource(src)).toBe('-- no imports\ntheorem bar : 2 = 2 := rfl');
  });

  it('handles source with only imports', () => {
    expect(r._prepareSource('import Mathlib\nimport Std')).toBe('');
  });

  it('does not strip mid-line import mentions', () => {
    const src = 'theorem foo : 1 = 1 := by -- import Mathlib\n  rfl';
    const result = r._prepareSource(src);
    expect(result).toContain('-- import Mathlib');
  });
});

describe('LeanRepl._responseToResult', () => {
  const r = new LeanRepl(WORKSPACE);

  it('returns success=true for empty messages', () => {
    const result = r._responseToResult({ env: 1, messages: [], sorries: [] }, null);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.usedMathlib).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('maps error message to errors array', () => {
    const response = {
      env: 1,
      messages: [{
        severity: 'error',
        data: "unknown identifier 'foo'",
        pos: { line: 3, column: 5 },
        endPos: { line: 3, column: 8 },
      }],
      sorries: [],
    };
    const result = r._responseToResult(response, null);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      severity: 'error',
      message: "unknown identifier 'foo'",
      line: 3,
      col: 5,
      file: 'theorem.lean',
    });
  });

  it("normalises 'information' severity to 'info' in errors array", () => {
    const response = {
      env: 1,
      messages: [{
        severity: 'information',
        data: 'Try this: exact h',
        pos: { line: 1, column: 0 },
      }],
      sorries: [],
    };
    const result = r._responseToResult(response, null);
    expect(result.errors[0].severity).toBe('info');
  });

  it('keeps information (not info) in rawOutput for _parseGoalStates compatibility', () => {
    const response = {
      env: 1,
      messages: [{
        severity: 'information',
        data: 'Try this: exact h',
        pos: { line: 1, column: 0 },
      }],
      sorries: [],
    };
    const result = r._responseToResult(response, null);
    expect(result.rawOutput).toContain('information:');
  });

  it('includes sorry goal as information: lines in rawOutput', () => {
    const response = {
      env: 1,
      messages: [{
        severity: 'warning',
        data: "declaration uses 'sorry'",
        pos: { line: 1, column: 0 },
      }],
      sorries: [{
        proofState: 0,
        goal: 'n : Nat\n⊢ n + 0 = n',
        pos: { line: 1, column: 29 },
        endPos: { line: 1, column: 34 },
      }],
    };
    const result = r._responseToResult(response, null);
    expect(result.rawOutput).toContain('theorem.lean:1:29: information: ');
    expect(result.rawOutput).toContain('n : Nat');
    expect(result.rawOutput).toContain('⊢ n + 0 = n');
  });

  it('calls onLine for every rawOutput line', () => {
    const lines = [];
    const response = {
      env: 1,
      messages: [{ severity: 'error', data: 'oops', pos: { line: 2, column: 1 } }],
      sorries: [],
    };
    r._responseToResult(response, l => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('error: oops');
  });

  it('handles missing pos gracefully', () => {
    const response = {
      env: 1,
      messages: [{ severity: 'error', data: 'internal error' }],
      sorries: [],
    };
    const result = r._responseToResult(response, null);
    expect(result.errors[0].line).toBe(0);
    expect(result.errors[0].col).toBe(0);
  });

  it('success is false only when there are error-severity messages', () => {
    const responseWarn = {
      env: 1,
      messages: [{ severity: 'warning', data: "declaration uses 'sorry'", pos: { line: 1, column: 0 } }],
      sorries: [],
    };
    expect(r._responseToResult(responseWarn, null).success).toBe(true);
  });

  it('reflects usesMathlib in result', () => {
    const noMathlib = new LeanRepl(WORKSPACE, { usesMathlib: false });
    const result = noMathlib._responseToResult({ env: 0, messages: [], sorries: [] }, null);
    expect(result.usedMathlib).toBe(false);
  });
});

describe('LeanRepl.stop (unstarted)', () => {
  it('resolves without error when stop() called before start()', async () => {
    const r = new LeanRepl(WORKSPACE);
    await expect(r.stop()).resolves.toBeUndefined();
    expect(r._stopped).toBe(true);
  });

  it('start() rejects after stop()', async () => {
    const r = new LeanRepl(WORKSPACE);
    await r.stop();
    await expect(r.start()).rejects.toThrow('stopped');
  });
});

describe('LeanRepl._buildPathStr', () => {
  it('returns a non-empty path string', () => {
    const r = new LeanRepl(WORKSPACE);
    expect(typeof r._buildPathStr()).toBe('string');
    expect(r._buildPathStr().length).toBeGreaterThan(0);
  });
});

// ─── _extractPos: support both object + array pos formats (Bug D) ──────────
describe('LeanRepl._extractPos', () => {
  const r = new LeanRepl(WORKSPACE);

  it('handles current object-form pos', () => {
    expect(r._extractPos({ line: 3, column: 5 })).toEqual({ line: 3, col: 5 });
  });

  it('handles array-form pos from older REPL builds', () => {
    // Regression guard: without this, older REPL versions produced pos=0:0
    // for every diagnostic because msg.pos?.line was undefined on arrays.
    expect(r._extractPos([7, 2])).toEqual({ line: 7, col: 2 });
  });

  it('handles null/undefined pos', () => {
    expect(r._extractPos(null)).toEqual({ line: 0, col: 0 });
    expect(r._extractPos(undefined)).toEqual({ line: 0, col: 0 });
  });

  it('handles partially-populated pos object', () => {
    expect(r._extractPos({ line: 4 })).toEqual({ line: 4, col: 0 });
    expect(r._extractPos({ column: 2 })).toEqual({ line: 0, col: 2 });
  });
});

describe('LeanRepl._responseToResult — pos format compatibility', () => {
  it('parses array-form pos correctly in messages (Bug D regression)', () => {
    const r = new LeanRepl(WORKSPACE);
    const result = r._responseToResult({
      env: 1,
      messages: [{ severity: 'error', data: 'oops', pos: [9, 4] }],
      sorries: [],
    }, null);
    expect(result.errors[0].line).toBe(9);
    expect(result.errors[0].col).toBe(4);
    expect(result.rawOutput).toContain('theorem.lean:9:4:');
  });

  it('parses array-form pos in sorries', () => {
    const r = new LeanRepl(WORKSPACE);
    const result = r._responseToResult({
      env: 1,
      messages: [],
      sorries: [{ pos: [5, 10], goal: '⊢ Nat' }],
    }, null);
    expect(result.rawOutput).toContain('theorem.lean:5:10: information: ');
    expect(result.rawOutput).toContain('⊢ Nat');
  });
});

// ─── Crash cleanup (Bug A) ─────────────────────────────────────────────────
// When the REPL process dies, every pending command — BOTH the in-flight one
// AND everything queued behind it — must be rejected. Otherwise queued items
// stall forever or, worse, are later drained to the restarted process with
// a stale env ID captured from the previous process.

describe('LeanRepl._onClose — queue cleanup', () => {
  it('rejects inflight item with "REPL process exited"', async () => {
    const r = new LeanRepl(WORKSPACE);
    r._stopped = true; // suppress auto-restart

    let rejectedWith;
    r._inflight = {
      cmd: 'test',
      timer: null,
      resolve: () => {},
      reject: err => { rejectedWith = err; },
    };

    r._onClose(1);
    expect(rejectedWith).toBeInstanceOf(Error);
    expect(rejectedWith.message).toMatch(/REPL process exited/);
    expect(r._inflight).toBeNull();
  });

  it('rejects every queued item too (not just inflight)', async () => {
    const r = new LeanRepl(WORKSPACE);
    r._stopped = true; // suppress auto-restart

    const rejections = [];
    const mkItem = () => ({
      cmd: 'x', timer: null,
      resolve: () => {},
      reject: err => rejections.push(err),
    });
    r._inflight = mkItem();
    r._queue = [mkItem(), mkItem(), mkItem()];

    r._onClose(1);

    expect(rejections).toHaveLength(4); // 1 inflight + 3 queued
    rejections.forEach(e => expect(e.message).toMatch(/REPL process exited/));
    expect(r._queue).toEqual([]);
    expect(r._inflight).toBeNull();
  });

  it('clears timers on every rejected item', async () => {
    const r = new LeanRepl(WORKSPACE);
    r._stopped = true;

    let cleared = 0;
    const origClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = (t) => { if (t) cleared++; origClearTimeout(t); };

    try {
      const mkItem = () => ({
        cmd: 'x',
        timer: setTimeout(() => {}, 60_000),
        resolve: () => {},
        reject: () => {},
      });
      r._inflight = mkItem();
      r._queue = [mkItem(), mkItem()];

      r._onClose(1);

      expect(cleared).toBeGreaterThanOrEqual(3);
    } finally {
      globalThis.clearTimeout = origClearTimeout;
    }
  });

  it('does not auto-restart when _stopped is true', () => {
    const r = new LeanRepl(WORKSPACE);
    r._stopped = true;
    r._ready = true;

    let restartScheduled = false;
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (_fn, _ms) => { restartScheduled = true; return 0; };

    try {
      r._onClose(0);
      expect(restartScheduled).toBe(false);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});

// ─── stop() rejects queued items (extended coverage) ────────────────────────
describe('LeanRepl.stop — full queue cleanup', () => {
  it('rejects inflight + queued items before the process teardown', async () => {
    const r = new LeanRepl(WORKSPACE);
    const rejections = [];
    const mkItem = () => ({
      cmd: 'x', timer: null,
      resolve: () => {},
      reject: err => rejections.push(err),
    });
    r._inflight = mkItem();
    r._queue = [mkItem(), mkItem()];

    await r.stop();

    expect(rejections).toHaveLength(3);
    rejections.forEach(e => expect(e.message).toMatch(/stopped/));
    expect(r._inflight).toBeNull();
    expect(r._queue).toEqual([]);
  });
});

// ─── start() dedup (Bug B: prevent orphan processes on restart) ─────────────
// Two concurrent callers of start() must receive the same promise, not two
// separate `_doStart` invocations. This is what prevents restarts from leaking
// a second `lake exe repl` child when a verify() races with the restart timer.

describe('LeanRepl.start — dedup', () => {
  it('returns the same in-flight promise to concurrent callers', () => {
    const r = new LeanRepl(WORKSPACE);
    // Fake in-flight start so we don't actually spawn anything
    const fakePromise = new Promise(() => {}); // never resolves in this test
    r._startPromise = fakePromise;

    const a = r.start();
    const b = r.start();
    expect(a).toBe(fakePromise);
    expect(b).toBe(fakePromise);
  });

  it('resolves immediately when already ready without launching _doStart again', async () => {
    const r = new LeanRepl(WORKSPACE);
    r._ready = true; // simulate ready state
    // If start() did anything wrong here, it would spawn or throw. Neither happens:
    await expect(r.start()).resolves.toBeUndefined();
  });

  it('rejects start() once stop() has been called', async () => {
    const r = new LeanRepl(WORKSPACE);
    await r.stop();
    await expect(r.start()).rejects.toThrow(/stopped/);
  });
});
