// Tests for src/main/context-assembler.js
// Covers: assembling proof context, resolving dependencies, formatting as prompt,
// LRU cap on proof memory (P-04), and graceful handling of missing markers.

import { describe, it, expect } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import { parseTheoryOutline } from '../outline-parser.js';

/** Build an outline from a TeX document and pick the target node by label. */
function buildOutline(tex, targetLabel) {
  const outline = parseTheoryOutline(tex);
  const target = targetLabel
    ? outline.nodes.find(n => n.labels?.includes(targetLabel))
    : outline.nodes[0];
  return { outline, target };
}

// IMPORTANT: the outline parser only harvests labels from the BODY of an
// environment (post-\begin), not from the \begin line itself. All test
// fixtures below place \label{} on its own line.

describe('ContextAssembler — assembleForProof', () => {
  it('populates preamble, target, and full document in the context object', () => {
    const tex = [
      '\\documentclass{article}',
      '\\newtheorem{theorem}{Theorem}',
      '\\begin{document}',
      '\\begin{theorem}',
      '\\label{thm:main}',
      '  Claim.',
      '\\end{theorem}',
      '% [PROVE IT: Medium]',
      '\\end{document}',
    ].join('\n');
    const { outline, target } = buildOutline(tex, 'thm:main');
    expect(target).toBeTruthy();
    const ca = new ContextAssembler();
    const ctx = ca.assembleForProof(outline, target);

    expect(ctx.preamble).toContain('\\documentclass{article}');
    expect(ctx.target.labels).toContain('thm:main');
    expect(ctx.target.statementTeX).toContain('\\begin{theorem}');
    expect(ctx.target.difficulty).toBe('Medium');
    expect(ctx.fullText).toContain('\\begin{document}');
  });

  it('resolves direct dependencies via \\ref', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{lemma}',
      '\\label{lem:a}',
      '  Helper A.',
      '\\end{lemma}',
      '\\begin{lemma}',
      '\\label{lem:b}',
      '  Helper B.',
      '\\end{lemma}',
      '\\begin{theorem}',
      '\\label{thm:main}',
      '  By \\ref{lem:a} and \\ref{lem:b}, result.',
      '\\end{theorem}',
      '% [PROVE IT: Medium]',
      '\\end{document}',
    ].join('\n');
    const { outline, target } = buildOutline(tex, 'thm:main');
    expect(target).toBeTruthy();
    const ca = new ContextAssembler();
    const ctx = ca.assembleForProof(outline, target);
    const depLabels = ctx.directDependencies.flatMap(d => d.labels || []);
    expect(depLabels).toEqual(expect.arrayContaining(['lem:a', 'lem:b']));
  });

  it('returns an empty directDependencies array when the target has no refs', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}',
      '\\label{thm:trivial}',
      '  Standalone statement.',
      '\\end{theorem}',
      '% [PROVE IT: Easy]',
      '\\end{document}',
    ].join('\n');
    const { outline, target } = buildOutline(tex, 'thm:trivial');
    expect(target).toBeTruthy();
    const ca = new ContextAssembler();
    const ctx = ca.assembleForProof(outline, target);
    expect(ctx.directDependencies).toEqual([]);
    expect(ctx.transitiveDependencies).toEqual([]);
  });

  it('defaults target.difficulty to "Medium" when no marker is present', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}',
      '\\label{thm:x}',
      '  Claim.',
      '\\end{theorem}',
      '\\end{document}',
    ].join('\n');
    const { outline, target } = buildOutline(tex, 'thm:x');
    expect(target).toBeTruthy();
    const ca = new ContextAssembler();
    const ctx = ca.assembleForProof(outline, target);
    expect(ctx.target.difficulty).toBe('Medium');
  });
});

describe('ContextAssembler — formatAsPrompt', () => {
  it('emits structured XML-like sections that the model prompt expects', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}',
      '\\label{thm:x}',
      '  Claim.',
      '\\end{theorem}',
      '% [PROVE IT: Hard]',
      '\\end{document}',
    ].join('\n');
    const { outline, target } = buildOutline(tex, 'thm:x');
    expect(target).toBeTruthy();
    const ca = new ContextAssembler();
    const prompt = ca.formatAsPrompt(ca.assembleForProof(outline, target));
    expect(prompt).toMatch(/<theory_map>[\s\S]*<\/theory_map>/);
    expect(prompt).toMatch(/<target difficulty="Hard">/);
    expect(prompt).toMatch(/<full_document>[\s\S]*<\/full_document>/);
  });

  it('includes <user_sketch> when the target has a userSketch attached', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}',
      '\\label{thm:x}',
      '  Claim.',
      '\\end{theorem}',
      '\\end{document}',
    ].join('\n');
    const { outline, target } = buildOutline(tex, 'thm:x');
    expect(target).toBeTruthy();
    target.userSketch = 'Induction on n.';
    const ca = new ContextAssembler();
    const prompt = ca.formatAsPrompt(ca.assembleForProof(outline, target));
    expect(prompt).toContain('<user_sketch>');
    expect(prompt).toContain('Induction on n.');
  });
});

describe('ContextAssembler — proof memory (recordAcceptedProof)', () => {
  it('stores proofs so they appear in knownProofs for dependent theorems', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{lemma}',
      '\\label{lem:helper}',
      '  Helper statement.',
      '\\end{lemma}',
      '\\begin{theorem}',
      '\\label{thm:main}',
      '  By \\ref{lem:helper}, done.',
      '\\end{theorem}',
      '% [PROVE IT: Easy]',
      '\\end{document}',
    ].join('\n');
    const { outline, target } = buildOutline(tex, 'thm:main');
    expect(target).toBeTruthy();
    const ca = new ContextAssembler();
    ca.recordAcceptedProof('lem:helper', '\\begin{lemma}...\\end{lemma}', '\\begin{proof}QED.\\end{proof}');
    const ctx = ca.assembleForProof(outline, target);
    const found = ctx.knownProofs.find(p => p.label === 'lem:helper');
    expect(found).toBeTruthy();
    expect(found.proofTeX).toContain('QED');
  });

  it('P-04: evicts oldest entries past the 40-entry LRU cap', () => {
    const ca = new ContextAssembler();
    for (let i = 0; i < 50; i++) {
      ca.recordAcceptedProof(`lem:${i}`, `stmt${i}`, `proof${i}`);
    }
    expect(ca.proofMemory.size).toBeLessThanOrEqual(40);
    expect(ca.proofMemory.has('lem:0')).toBe(false);
    expect(ca.proofMemory.has('lem:49')).toBe(true);
  });

  it('LRU: re-recording an existing label moves it to most-recent', () => {
    const ca = new ContextAssembler();
    for (let i = 0; i < 40; i++) ca.recordAcceptedProof(`lem:${i}`, 's', 'p');
    // Touch lem:0 — it should survive the next eviction.
    ca.recordAcceptedProof('lem:0', 's-updated', 'p-updated');
    ca.recordAcceptedProof('lem:40', 's', 'p');  // push out the oldest (which is now lem:1)
    expect(ca.proofMemory.has('lem:0')).toBe(true);
    expect(ca.proofMemory.has('lem:1')).toBe(false);
    expect(ca.proofMemory.get('lem:0').proofTeX).toBe('p-updated');
  });
});
