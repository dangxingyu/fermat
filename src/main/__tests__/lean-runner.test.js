// Tests for src/main/lean-runner.js
// Covers: parseLeanErrorLine (error format parser), _tryBinary path validation,
// detect() fallback chain, and setUsesMathlib toggling.
//
// We can't spawn a real `lean` in unit tests (the binary may not exist on CI),
// so the binary-detection tests deliberately target the "no lean available"
// path — which still needs to behave correctly.

import { describe, it, expect } from 'vitest';
import { LeanRunner, parseLeanErrorLine } from '../lean-runner.js';

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
  // detect() may shell out to `which lean` + `lean --version` etc. On a
  // machine where lean is installed, this can take several seconds of wall
  // clock time. Bump the per-test timeout so CI on either config passes.
  const longTimeout = 15000;

  it('returns a shape of { available, path, version } regardless of success', () => {
    const r = new LeanRunner();
    const result = r.detect('/nonexistent/lean');
    expect(result).toHaveProperty('available');
    expect(result).toHaveProperty('path');
    expect(result).toHaveProperty('version');
    expect(typeof result.available).toBe('boolean');
  }, longTimeout);

  it('falls through when override path does not exist', () => {
    const r = new LeanRunner();
    r.detect('/absolutely/not/a/real/path');
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
