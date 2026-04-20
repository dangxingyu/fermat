// Tests for src/main/outline-parser.js
// Covers: sectioning, theorem environments, PROVE IT markers, empty input,
// nested / adjacent theorems, label→ref dependency edges.

import { describe, it, expect } from 'vitest';
import { parseTheoryOutline } from '../outline-parser.js';

describe('parseTheoryOutline — basic structure', () => {
  it('returns empty nodes/edges for empty input', () => {
    const out = parseTheoryOutline('');
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.preamble).toBe('');
  });

  it('returns empty nodes for plain prose', () => {
    const out = parseTheoryOutline('This is a paragraph.\nNo theorems here.\n');
    expect(out.nodes).toEqual([]);
  });

  it('extracts preamble up to \\begin{document}', () => {
    const tex = [
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '\\newtheorem{theorem}{Theorem}',
      '',
      '\\begin{document}',
      'Hello.',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    expect(out.preamble).toContain('\\documentclass{article}');
    expect(out.preamble).toContain('\\usepackage{amsmath}');
    // Preamble should NOT include anything after \begin{document}
    expect(out.preamble).not.toContain('Hello');
  });
});

describe('parseTheoryOutline — sections', () => {
  it('captures \\section and \\subsection as section nodes', () => {
    const tex = [
      '\\begin{document}',
      '\\section{Introduction}',
      '\\subsection{Motivation}',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    const sections = out.nodes.filter(n => n.type === 'section');
    expect(sections.length).toBe(2);
    expect(sections[0].name).toBe('Introduction');
    expect(sections[0].sectionLevel).toBe('section');
    expect(sections[1].name).toBe('Motivation');
    expect(sections[1].sectionLevel).toBe('subsection');
  });
});

describe('parseTheoryOutline — theorem environments', () => {
  it('captures a simple \\begin{theorem}…\\end{theorem} block', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}[Pythagoras]',
      '  $a^2 + b^2 = c^2$.',
      '\\end{theorem}',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    const thms = out.nodes.filter(n => n.type === 'theorem');
    expect(thms.length).toBe(1);
    expect(thms[0].name).toBe('Pythagoras');
    expect(thms[0].statementTeX).toContain('a^2 + b^2 = c^2');
    expect(thms[0].statementTeX).toContain('\\begin{theorem}');
    expect(thms[0].statementTeX).toContain('\\end{theorem}');
  });

  it('recognises all theorem-like env types', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{lemma}',
      '  Lemma body.',
      '\\end{lemma}',
      '\\begin{proposition}',
      '  Prop body.',
      '\\end{proposition}',
      '\\begin{corollary}',
      '  Cor body.',
      '\\end{corollary}',
      '\\begin{definition}',
      '  Def body.',
      '\\end{definition}',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    const types = out.nodes.map(n => n.type);
    expect(types).toEqual(expect.arrayContaining(['lemma', 'proposition', 'corollary', 'definition']));
  });

  it('attaches \\label inside a theorem to that theorem', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}',
      '\\label{thm:foo}',
      '  Statement.',
      '\\end{theorem}',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    const thm = out.nodes.find(n => n.type === 'theorem');
    expect(thm.labels).toContain('thm:foo');
  });

  it('marks a theorem as hasProof when \\begin{proof} follows', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}\\label{thm:x}',
      '  Statement.',
      '\\end{theorem}',
      '\\begin{proof}',
      '  QED.',
      '\\end{proof}',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    const thm = out.nodes.find(n => n.type === 'theorem');
    expect(thm.hasProof).toBe(true);
    expect(thm.proofTeX).toContain('\\begin{proof}');
    expect(thm.proofTeX).toContain('\\end{proof}');
  });
});

describe('parseTheoryOutline — PROVE IT markers', () => {
  it('parses [PROVE IT: Easy] marker after a theorem', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}\\label{thm:t}',
      '  Claim.',
      '\\end{theorem}',
      '% [PROVE IT: Easy]',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    const thm = out.nodes.find(n => n.type === 'theorem');
    expect(thm.proveItMarker).toBeTruthy();
    expect(thm.proveItMarker.difficulty).toBe('Easy');
  });

  it('parses difficulty Medium and Hard', () => {
    for (const diff of ['Medium', 'Hard']) {
      const tex = [
        '\\begin{document}',
        '\\begin{lemma}',
        '  Claim.',
        '\\end{lemma}',
        `% [PROVE IT: ${diff}]`,
        '\\end{document}',
      ].join('\n');
      const out = parseTheoryOutline(tex);
      const lemma = out.nodes.find(n => n.type === 'lemma');
      expect(lemma).toBeTruthy();
      expect(lemma.proveItMarker?.difficulty).toBe(diff);
    }
  });

  it('parses preferred model hint in marker', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}',
      '  T.',
      '\\end{theorem}',
      '% [PROVE IT: Hard, model=opus]',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    const thm = out.nodes[0];
    expect(thm.proveItMarker?.difficulty).toBe('Hard');
    expect(thm.proveItMarker?.preferredModel).toBe('opus');
  });
});

describe('parseTheoryOutline — dependency edges (\\ref → \\label)', () => {
  it('creates a ref edge from a theorem to a lemma it cites', () => {
    // Labels need to be on their own line inside the env — the parser only
    // harvests labels from the body (post-\begin), not from the \begin line
    // itself. Put them on dedicated \label lines.
    const tex = [
      '\\begin{document}',
      '\\begin{lemma}',
      '\\label{lem:helper}',
      '  Helper.',
      '\\end{lemma}',
      '\\begin{theorem}',
      '\\label{thm:main}',
      '  By \\ref{lem:helper}, result follows.',
      '\\end{theorem}',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    const thm = out.nodes.find(n => n.labels?.includes('thm:main'));
    const lem = out.nodes.find(n => n.labels?.includes('lem:helper'));
    expect(thm).toBeTruthy();
    expect(lem).toBeTruthy();
    expect(thm.refs).toContain('lem:helper');
    const edge = out.edges.find(e => e.from === thm.id && e.to === lem.id);
    expect(edge).toBeTruthy();
    expect(edge.type).toBe('ref');
  });

  it('does not create an edge when the ref target does not exist', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}',
      '  By \\ref{lem:missing}, done.',
      '\\end{theorem}',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    expect(out.edges).toEqual([]);
  });
});

describe('parseTheoryOutline — regression: B-08 lastIndex leak', () => {
  // B-08: module-scope `g`-flag regexes used to leak lastIndex across calls,
  // silently skipping the first few chars on the next invocation. Two back-to-back
  // parses of the same text must produce identical node arrays.
  it('is idempotent across repeated calls', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{lemma}',
      '\\label{lem:a}',
      '  One.',
      '\\end{lemma}',
      '\\begin{lemma}',
      '\\label{lem:b}',
      '  Two.',
      '\\end{lemma}',
      '\\begin{theorem}',
      '\\label{thm:x}',
      '  By \\ref{lem:a} and \\ref{lem:b}, result.',
      '\\end{theorem}',
      '\\end{document}',
    ].join('\n');
    const a = parseTheoryOutline(tex);
    const b = parseTheoryOutline(tex);
    expect(b.nodes.map(n => n.labels)).toEqual(a.nodes.map(n => n.labels));
    expect(b.edges.length).toBe(a.edges.length);
  });
});

describe('parseTheoryOutline — adjacent / multiple theorems', () => {
  it('distinguishes proofs for multiple theorems in sequence', () => {
    const tex = [
      '\\begin{document}',
      '\\begin{theorem}',
      '\\label{thm:a}',
      '  A.',
      '\\end{theorem}',
      '\\begin{proof}',
      '  Proof of A.',
      '\\end{proof}',
      '\\begin{theorem}',
      '\\label{thm:b}',
      '  B.',
      '\\end{theorem}',
      '\\begin{proof}',
      '  Proof of B.',
      '\\end{proof}',
      '\\end{document}',
    ].join('\n');
    const out = parseTheoryOutline(tex);
    const a = out.nodes.find(n => n.labels?.includes('thm:a'));
    const b = out.nodes.find(n => n.labels?.includes('thm:b'));
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a.hasProof).toBe(true);
    expect(a.proofTeX).toContain('Proof of A');
    expect(b.hasProof).toBe(true);
    expect(b.proofTeX).toContain('Proof of B');
  });
});
