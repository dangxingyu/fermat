import { describe, expect, it } from 'vitest';
import { factUseAllowed, formatEvidencePolicyForPrompt } from '../evidence-policy.js';

describe('evidence policy', () => {
  it('allows only source-backed facts with matching conditions or run-verified facts', () => {
    expect(factUseAllowed({
      tier: 'T1_SOURCE_BACKED',
      usePolicy: 'cite_directly',
      conditionMatch: 'matches',
    }).allowed).toBe(true);
    expect(factUseAllowed({
      tier: 'T1_SOURCE_BACKED',
      usePolicy: 'cite_directly',
      conditionMatch: 'mismatch',
    }).allowed).toBe(false);
    expect(factUseAllowed({
      tier: 'T3_LIKELY_PROVABLE',
      usePolicy: 'cite_directly',
    }).allowed).toBe(false);
    expect(factUseAllowed({ tier: 'RUN_VERIFIED' }).allowed).toBe(true);
  });

  it('formats usable source and partial facts for proof prompts', () => {
    const block = formatEvidencePolicyForPrompt({
      sourceCards: [{
        id: 'src-1',
        title: 'A source',
        extractedClaims: [{
          id: 'claim-1',
          statement: 'A theorem.',
          tier: 'T1_SOURCE_BACKED',
          usePolicy: 'cite_directly',
          conditionMatch: 'matches',
        }],
      }],
      partialResults: [{ id: 'partial-1', statement: 'A proved sublemma.' }],
    });

    expect(block).toContain('<evidence_policy>');
    expect(block).toContain('A theorem.');
    expect(block).toContain('A proved sublemma.');
  });
});
