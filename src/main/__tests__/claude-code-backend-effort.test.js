import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeCodeBackend } from '../claude-code-backend.js';

function makeBackend() {
  return new ClaudeCodeBackend();
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('ClaudeCodeBackend effort proof helpers', () => {
  it('extracts verifier verdict tags defensively', () => {
    const backend = makeBackend();

    expect(backend._extractVerdictTag('<verdict>PASS</verdict>')).toBe('PASS');
    expect(backend._extractVerdictTag('<verdict> needs_revision </verdict>')).toBe('NEEDS_REVISION');
    expect(backend._extractVerdictTag('no structured verdict')).toBe('UNKNOWN');
    expect(backend._extractTagText('<status>Needs_Research</status>', 'status')).toBe('needs_research');
  });

  it('extracts corrected proofs only when the verifier supplied a proof block', () => {
    const backend = makeBackend();
    const verdict = [
      '<verdict>NEEDS_REVISION</verdict>',
      '<corrected_proof>',
      '\\begin{proof}',
      'A corrected argument.',
      '\\end{proof}',
      '</corrected_proof>',
    ].join('\n');

    expect(backend._extractCorrectedProof(verdict)).toContain('A corrected argument');
    expect(backend._extractCorrectedProof('<corrected_proof>none</corrected_proof>')).toBe('');
  });

  it('formats failed proof attempts into a repair prompt without unbounded raw output', () => {
    const backend = makeBackend();
    const attempts = [{
      index: 0,
      role: 'primary',
      proof: `\\begin{proof}\n${'x'.repeat(5000)}\n\\end{proof}`,
      verdictTag: 'FAIL',
      verdict: '<verdict>FAIL</verdict>',
    }];

    const formatted = backend._formatProofAttemptsForPrompt(attempts);

    expect(formatted).toContain('<attempt index="0" role="primary" verdict="FAIL">');
    expect(formatted).toContain('[FERMAT: truncated');
    expect(formatted.length).toBeLessThan(10000);
  });

  it('bounds max-effort pipeline width and emits independent attempt roles', () => {
    const backend = makeBackend();

    expect(backend._boundedInt('10', 3, 2, 5)).toBe(5);
    expect(backend._boundedInt('bad', 3, 2, 5)).toBe(3);
    expect(backend._maxAttemptDirectives(3, 2).map(d => d.role)).toEqual([
      'primary',
      'obligation-first',
      'adversarial-repair',
    ]);
  });

  it('injects scheduler focus into max-effort attempt prompts', () => {
    const backend = makeBackend();
    const [directive] = backend._maxAttemptDirectives(1, 1, {
      focus: 'prove_obligations',
      rationale: 'Attack selected obligations first.',
      selectedObligations: [{
        statement: 'Every maximal counterexample has a minimal bad subconfiguration.',
        tier: 'T3_LIKELY_PROVABLE',
        usePolicy: 'prove_inline',
        confidence: 'medium',
        neededFor: 'counterexample descent',
      }],
      selectedRoutes: [],
    });

    expect(directive.instruction).toContain('Scheduler focus: prove_obligations');
    expect(directive.instruction).toContain('minimal bad subconfiguration');
    expect(directive.instruction).toContain('use_policy=prove_inline');
  });

  it('returns a visible blocked proof when the effort pipeline cannot certify a proof', () => {
    const backend = makeBackend();
    const blocked = backend._blockedProof('Unsupported concentration bound.\nNeeds a separate lemma.');

    expect(blocked).toContain('\\begin{proof}');
    expect(blocked).toContain('[FERMAT BLOCKED]');
    expect(blocked).toContain('Unsupported concentration bound');
    expect(blocked).toContain('\\end{proof}');
  });

  it('persists compact max-effort run snapshots beside the project', () => {
    const backend = makeBackend();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-max-run-'));
    fs.mkdirSync(path.join(root, '.git'));
    const filePath = path.join(root, 'paper.tex');
    const run = {
      mode: 'max-long-range',
      runId: 'run-test',
      width: 3,
      maxStages: 2,
      selectedAttempt: null,
      finalVerdict: '<verdict>FAIL</verdict>',
      notebook: '<proof_notebook><status>blocked</status></proof_notebook>',
      attempts: [{ index: 0, stage: 1, role: 'primary', proof: '\\begin{proof}x\\end{proof}', verdict: '<verdict>FAIL</verdict>' }],
      stages: [],
    };

    const runPath = backend._persistProofRunSnapshot(run, {
      id: 'node_1',
      type: 'theorem',
      name: 'Target',
      labels: ['thm:target'],
      lineNumber: 12,
    }, { marker: { filePath } });

    expect(runPath).toBe(path.join(root, '.fermat', 'proof-runs', 'run-test.json'));
    const saved = JSON.parse(fs.readFileSync(runPath, 'utf-8'));
    expect(saved.run.mode).toBe('max-long-range');
    expect(saved.run.finalVerdictTag).toBe('FAIL');
    expect(saved.target.labels).toEqual(['thm:target']);
  });
});
