import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTheoryOutline } from '../outline-parser.js';
import {
  extractJsonObject,
  loadOutlineAudit,
  nodeAuditKey,
  normalizeOutlineAudit,
  resolveAuditPath,
  saveOutlineAudit,
  statementHashForNode,
} from '../outline-audit.js';

function sampleTex(statement = 'Every even square is divisible by 4.') {
  return [
    '\\begin{document}',
    '\\begin{lemma}',
    '\\label{lem:even-square}',
    `  ${statement}`,
    '\\end{lemma}',
    '\\begin{theorem}',
    '\\label{thm:main}',
    '  This follows from Lemma~\\ref{lem:even-square}.',
    '\\end{theorem}',
    '\\end{document}',
  ].join('\n');
}

describe('outline audit data contract', () => {
  it('uses labels as stable node keys and hashes statements consistently', () => {
    const outline = parseTheoryOutline(sampleTex());
    const lemma = outline.nodes.find(n => n.labels?.includes('lem:even-square'));

    expect(nodeAuditKey(lemma)).toBe('label:lem:even-square');
    expect(lemma.statementHash).toBeTruthy();
    expect(statementHashForNode(lemma)).toBe(lemma.statementHash);
  });

  it('extracts strict JSON from plain or fenced model output', () => {
    expect(extractJsonObject('{"schemaVersion":1,"nodes":{}}')).toEqual({
      schemaVersion: 1,
      nodes: {},
    });
    expect(extractJsonObject('```json\n{"schemaVersion":1,"nodes":{}}\n```')).toEqual({
      schemaVersion: 1,
      nodes: {},
    });
  });

  it('normalizes raw LLM output into one entry per theorem-like node', () => {
    const tex = sampleTex();
    const outline = parseTheoryOutline(tex);
    const rawAudit = {
      schemaVersion: 1,
      nodes: {
        'label:thm:main': {
          suggested_dependencies: [{
            target_label: 'lem:even-square',
            statement: 'The theorem needs the even-square lemma.',
            confidence: 'HIGH',
            use_policy: 'cite_existing',
          }],
          proof_obligations: [{
            statement: 'Show the parity reduction step.',
            use_policy: 'not-a-policy',
          }],
        },
      },
    };

    const audit = normalizeOutlineAudit(rawAudit, {
      outline,
      texContent: tex,
      filePath: '/tmp/paper/main.tex',
    });

    expect(Object.keys(audit.nodes)).toEqual([
      'label:lem:even-square',
      'label:thm:main',
    ]);
    expect(audit.nodes['label:thm:main'].suggestedDependencies[0]).toMatchObject({
      targetLabel: 'lem:even-square',
      confidence: 'high',
      usePolicy: 'cite_existing',
    });
    expect(audit.nodes['label:thm:main'].proofObligations[0]).toMatchObject({
      statement: 'Show the parity reduction step.',
      confidence: 'medium',
      usePolicy: 'research_before_use',
    });
  });
});

describe('outline audit persistence', () => {
  it('places the audit file in the nearest project .fermat directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-audit-'));
    fs.mkdirSync(path.join(root, '.fermat'));
    fs.mkdirSync(path.join(root, 'paper'));
    const filePath = path.join(root, 'paper', 'main.tex');

    expect(resolveAuditPath(filePath)).toBe(path.join(root, '.fermat', 'outline-audit.json'));
  });

  it('loads saved audits and marks changed nodes stale', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-audit-'));
    const filePath = path.join(root, 'main.tex');
    const texV1 = sampleTex('Every even square is divisible by 4.');
    const outlineV1 = parseTheoryOutline(texV1);
    const audit = normalizeOutlineAudit({
      schemaVersion: 1,
      nodes: {
        'label:lem:even-square': {
          warnings: [{ statement: 'Check the hidden parity argument.' }],
        },
      },
    }, {
      outline: outlineV1,
      texContent: texV1,
      filePath,
    });

    const auditPath = saveOutlineAudit(audit, filePath);
    expect(fs.existsSync(auditPath)).toBe(true);

    const texV2 = sampleTex('Every even square is divisible by 8.');
    const loaded = loadOutlineAudit({
      filePath,
      texContent: texV2,
      outline: parseTheoryOutline(texV2),
    });

    expect(loaded.isStale).toBe(true);
    expect(loaded.nodes['label:lem:even-square'].status).toBe('stale');
    expect(loaded.nodes['label:thm:main'].status).toBe('fresh');
  });
});
