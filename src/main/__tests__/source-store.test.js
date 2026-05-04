import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SourceStore,
  formatSourceCardsForPrompt,
  normalizeSourceCard,
  resolveFermatDir,
} from '../source-store.js';

describe('SourceStore', () => {
  it('normalizes deterministic source cards and persists merged claims', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-source-store-'));
    const store = new SourceStore(path.join(root, '.fermat'));

    const first = store.saveCard({
      sourceType: 'arxiv',
      title: 'Arithmetic progressions in dense sets',
      authors: ['A. Author'],
      identifiers: { arxiv: '1234.5678' },
      abstract: 'A theorem about progressions.',
    });
    const second = store.saveCard({
      sourceType: 'arxiv',
      title: 'Arithmetic progressions in dense sets',
      identifiers: { arxiv: '1234.5678' },
      reviewStatus: 'read',
      extractedClaims: [{ statement: 'Dense sets contain progressions.', conditionMatch: 'matches' }],
    });

    expect(second.id).toBe(first.id);
    expect(store.listCards()).toHaveLength(1);
    expect(store.openCard(first.id).reviewStatus).toBe('read');
    expect(store.openCard(first.id).extractedClaims[0].statement).toBe('Dense sets contain progressions.');
  });

  it('formats source cards into prompt evidence without leaking raw objects', () => {
    const card = normalizeSourceCard({
      sourceType: 'doi',
      title: 'A result',
      doi: '10.1000/example',
      extractedClaims: [{ statement: 'A cited theorem.', sourceRef: 'Theorem 1' }],
    });

    const block = formatSourceCardsForPrompt([card]);

    expect(block).toContain('<source_cards>');
    expect(block).toContain('<doi>10.1000/example</doi>');
    expect(block).toContain('<claim');
    expect(block).toContain('A cited theorem.');
  });

  it('resolves .fermat beside the project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-source-root-'));
    fs.mkdirSync(path.join(root, '.git'));
    const filePath = path.join(root, 'src', 'paper.tex');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');

    expect(resolveFermatDir({ filePath })).toBe(path.join(root, '.fermat'));
  });
});
