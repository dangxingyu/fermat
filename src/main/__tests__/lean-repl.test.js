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
