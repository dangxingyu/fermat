import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KnowledgeStore, extractLedgerProposalsFromResearch } from '../knowledge-store.js';

describe('KnowledgeStore', () => {
  it('deduplicates proposals and appends accepted entries to knowledge.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-knowledge-'));
    const store = new KnowledgeStore(path.join(root, '.fermat'));

    const proposal = store.addProposal({
      tier: 'T1_SOURCE_BACKED',
      usePolicy: 'cite_directly',
      statement: 'A theorem applies.',
      sourceRefs: 'src-1 Theorem 2',
    });
    store.addProposal({ ...proposal, notes: 'same proposal with notes' });

    expect(store.listProposals()).toHaveLength(1);
    const accepted = store.acceptProposal(proposal.id);
    expect(accepted.status).toBe('accepted');
    expect(fs.readFileSync(path.join(root, '.fermat', 'knowledge.md'), 'utf-8')).toContain('A theorem applies.');
  });

  it('extracts XML ledger entries from a research review', () => {
    const proposals = extractLedgerProposalsFromResearch(`
      <research_review>
        <ledger_entries>
          <entry action="add">
            <tier>T1_SOURCE_BACKED</tier>
            <use_policy>cite_directly</use_policy>
            <statement>Known theorem.</statement>
            <source_refs>src-1</source_refs>
          </entry>
        </ledger_entries>
      </research_review>
    `);

    expect(proposals[0]).toMatchObject({
      tier: 'T1_SOURCE_BACKED',
      usePolicy: 'cite_directly',
      statement: 'Known theorem.',
      sourceRefs: 'src-1',
    });
  });
});
