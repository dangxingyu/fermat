const { stableHash } = require('./proof-run');

const USABLE_TIERS = new Set(['T0_DOCUMENT_PROVED', 'T1_SOURCE_BACKED', 'RUN_VERIFIED']);
const USABLE_POLICIES = new Set(['cite_existing', 'cite_directly']);
const BLOCKED_POLICIES = new Set(['research_before_use', 'do_not_use']);

function normalizeTier(value) {
  const key = String(value || '').trim();
  return key || 'T3_LIKELY_PROVABLE';
}

function normalizeUsePolicy(value) {
  const key = String(value || '').trim();
  return key || 'research_before_use';
}

function factUseAllowed(fact = {}) {
  const tier = normalizeTier(fact.tier);
  const usePolicy = normalizeUsePolicy(fact.usePolicy || fact.use_policy);
  const conditionMatch = String(fact.conditionMatch || fact.condition_match || '').trim().toLowerCase();
  if (fact.origin === 'run_verified' || tier === 'RUN_VERIFIED') return { allowed: true, reason: 'verified in this run' };
  if (BLOCKED_POLICIES.has(usePolicy)) return { allowed: false, reason: `use_policy=${usePolicy}` };
  if (!USABLE_TIERS.has(tier)) return { allowed: false, reason: `tier=${tier}` };
  if (!USABLE_POLICIES.has(usePolicy)) return { allowed: false, reason: `use_policy=${usePolicy}` };
  if (tier === 'T1_SOURCE_BACKED' && conditionMatch && !['matches', 'match', 'exact'].includes(conditionMatch)) {
    return { allowed: false, reason: `condition_match=${conditionMatch}` };
  }
  return { allowed: true, reason: `${tier}/${usePolicy}` };
}

function formatEvidencePolicyForPrompt({ sourceCards = [], partialResults = [] } = {}) {
  const usableSources = [];
  for (const card of sourceCards || []) {
    for (const claim of card.extractedClaims || []) {
      const policy = factUseAllowed(claim);
      usableSources.push({
        ...claim,
        sourceId: card.id,
        title: card.title,
        allowed: policy.allowed,
        reason: policy.reason,
      });
    }
  }

  const partials = (partialResults || []).map(item => ({
    id: item.id || `partial-${stableHash(item.statement || item.proofHash || '')}`,
    statement: item.statement || '',
    source: item.source || item.obligationId || '',
  }));

  const sourceRows = usableSources.slice(0, 20).map(item => [
    `  <fact id="${escapeXmlAttr(item.id)}" source_id="${escapeXmlAttr(item.sourceId)}" allowed="${item.allowed ? 'true' : 'false'}" reason="${escapeXmlAttr(item.reason)}">`,
    `    <statement>${escapeXmlText(item.statement)}</statement>`,
    item.conditions ? `    <conditions>${escapeXmlText(item.conditions)}</conditions>` : '',
    item.sourceRef ? `    <source_ref>${escapeXmlText(item.sourceRef)}</source_ref>` : '',
    '  </fact>',
  ].filter(Boolean).join('\n')).join('\n');

  const partialRows = partials.slice(0, 20).map(item => [
    `  <fact id="${escapeXmlAttr(item.id)}" tier="RUN_VERIFIED" allowed="true">`,
    `    <statement>${escapeXmlText(item.statement)}</statement>`,
    item.source ? `    <source>${escapeXmlText(item.source)}</source>` : '',
    '  </fact>',
  ].filter(Boolean).join('\n')).join('\n');

  return [
    '<evidence_policy>',
    '  <rule>Proofs may use only T0 document-proved facts, T1 source-backed facts with matching conditions, or RUN_VERIFIED sublemmas from this run.</rule>',
    '  <rule>Facts marked prove_inline, prove_as_sublemma, research_before_use, or do_not_use are not usable until proved or explicitly promoted.</rule>',
    '  <usable_source_facts>',
    sourceRows || '    <none />',
    '  </usable_source_facts>',
    '  <run_verified_facts>',
    partialRows || '    <none />',
    '  </run_verified_facts>',
    '</evidence_policy>',
  ].join('\n');
}

function collectVerifiedPartialResults(graph = {}) {
  return Object.values(graph.partialResults || {});
}

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

module.exports = {
  collectVerifiedPartialResults,
  factUseAllowed,
  formatEvidencePolicyForPrompt,
  normalizeTier,
  normalizeUsePolicy,
};
