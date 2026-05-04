const fs = require('fs');
const path = require('path');
const { extractTag, parseBlocks, stableHash } = require('./proof-run');

const KNOWLEDGE_SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function asString(value) {
  return value == null ? '' : String(value);
}

function normalizeUsePolicy(value) {
  const key = asString(value).trim();
  return key || 'research_before_use';
}

function normalizeTier(value) {
  const key = asString(value).trim();
  return key || 'T3_LIKELY_PROVABLE';
}

function normalizeProposal(candidate = {}) {
  const statement = asString(candidate.statement || candidate.claim).trim();
  const sourceRefs = asString(candidate.sourceRefs || candidate.source_refs || candidate.source_ref || '').trim();
  const id = candidate.id || `proposal-${stableHash([
    statement,
    normalizeTier(candidate.tier),
    normalizeUsePolicy(candidate.usePolicy || candidate.use_policy),
    sourceRefs,
  ].join('\n'))}`;
  return {
    id,
    status: candidate.status || 'proposed',
    createdAt: candidate.createdAt || nowIso(),
    updatedAt: nowIso(),
    action: asString(candidate.action || 'add').trim() || 'add',
    tier: normalizeTier(candidate.tier),
    usePolicy: normalizeUsePolicy(candidate.usePolicy || candidate.use_policy),
    statement,
    conditions: asString(candidate.conditions).trim(),
    sourceRefs,
    notes: asString(candidate.notes || candidate.reason).trim(),
    provenance: candidate.provenance || [],
  };
}

class KnowledgeStore {
  constructor(fermatDir) {
    if (!fermatDir) throw new Error('KnowledgeStore requires a .fermat directory.');
    this.fermatDir = fermatDir;
    this.jsonPath = path.join(fermatDir, 'knowledge.json');
    this.mdPath = path.join(fermatDir, 'knowledge.md');
    fs.mkdirSync(fermatDir, { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.jsonPath)) {
      return {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        updatedAt: nowIso(),
        entries: [],
        proposals: [],
      };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8'));
      return {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        updatedAt: raw.updatedAt || nowIso(),
        entries: Array.isArray(raw.entries) ? raw.entries : [],
        proposals: Array.isArray(raw.proposals) ? raw.proposals : [],
      };
    } catch {
      return {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        updatedAt: nowIso(),
        entries: [],
        proposals: [],
      };
    }
  }

  save(data) {
    const payload = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      updatedAt: nowIso(),
      entries: Array.isArray(data?.entries) ? data.entries : [],
      proposals: Array.isArray(data?.proposals) ? data.proposals : [],
    };
    fs.writeFileSync(this.jsonPath, JSON.stringify(payload, null, 2));
    return payload;
  }

  addProposal(candidate) {
    const proposal = normalizeProposal(candidate);
    const data = this.load();
    const existingIndex = data.proposals.findIndex(item => item.id === proposal.id);
    if (existingIndex >= 0) {
      data.proposals[existingIndex] = { ...data.proposals[existingIndex], ...proposal };
    } else {
      data.proposals.push(proposal);
    }
    this.save(data);
    return proposal;
  }

  addProposals(candidates = []) {
    return candidates.map(item => this.addProposal(item)).filter(item => item.statement);
  }

  listProposals({ includeAccepted = false } = {}) {
    const proposals = this.load().proposals;
    return includeAccepted ? proposals : proposals.filter(item => item.status !== 'accepted' && item.status !== 'rejected');
  }

  acceptProposal(proposalId) {
    const data = this.load();
    const proposal = data.proposals.find(item => item.id === proposalId);
    if (!proposal) throw new Error(`Knowledge proposal not found: ${proposalId}`);
    proposal.status = 'accepted';
    proposal.updatedAt = nowIso();
    data.entries.push({
      ...proposal,
      acceptedAt: nowIso(),
    });
    this.save(data);
    fs.appendFileSync(this.mdPath, formatAcceptedProposalMarkdown(proposal));
    return proposal;
  }
}

function formatAcceptedProposalMarkdown(proposal) {
  return [
    '',
    '',
    `## ${proposal.tier}: ${proposal.statement}`,
    '',
    `- use_policy: ${proposal.usePolicy}`,
    proposal.conditions ? `- conditions: ${proposal.conditions}` : '',
    proposal.sourceRefs ? `- source_refs: ${proposal.sourceRefs}` : '',
    proposal.notes ? `- notes: ${proposal.notes}` : '',
  ].filter(Boolean).join('\n');
}

function extractLedgerProposalsFromResearch(text, provenance = []) {
  const proposals = [];
  for (const block of parseBlocks(text, 'entry')) {
    const statement = extractTag(block.body, 'statement') || block.body.trim();
    if (!statement) continue;
    proposals.push(normalizeProposal({
      action: block.attrs.action || 'add',
      tier: extractTag(block.body, 'tier'),
      usePolicy: extractTag(block.body, 'use_policy') || extractTag(block.body, 'usePolicy'),
      statement,
      conditions: extractTag(block.body, 'conditions'),
      sourceRefs: extractTag(block.body, 'source_refs') || extractTag(block.body, 'sourceRefs'),
      notes: extractTag(block.body, 'notes'),
      provenance,
    }));
  }
  return proposals;
}

module.exports = {
  KNOWLEDGE_SCHEMA_VERSION,
  KnowledgeStore,
  extractLedgerProposalsFromResearch,
  normalizeProposal,
};
