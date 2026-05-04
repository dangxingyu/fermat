const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const MAX_EVENT_TEXT = 60_000;

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function targetSnapshot(target = {}) {
  return {
    id: target.id || null,
    type: target.type || null,
    name: target.name || null,
    labels: target.labels || [],
    lineNumber: target.lineNumber || null,
  };
}

function targetKey(target = {}) {
  const raw = target.labels?.[0] || target.name || target.id || 'target';
  return String(raw).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'target';
}

function truncateText(value, maxChars = MAX_EVENT_TEXT) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[FERMAT: truncated ${text.length - maxChars} chars]`;
}

function sanitizePayload(value) {
  if (typeof value === 'string') return truncateText(value);
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      out[key] = truncateText(item);
    } else if (Array.isArray(item)) {
      out[key] = item.map(sanitizePayload);
    } else if (item && typeof item === 'object') {
      out[key] = sanitizePayload(item);
    } else {
      out[key] = item;
    }
  }
  return out;
}

function createObligationGraph(target) {
  return {
    schemaVersion: SCHEMA_VERSION,
    target: targetSnapshot(target),
    status: 'open',
    updatedAt: nowIso(),
    claims: {},
    obligations: {},
    routes: {},
    attempts: {},
    verdicts: {},
    sourceCards: {},
    researchRuns: {},
    ledgerProposals: {},
    partialResults: {},
  };
}

function createProofRun({ runId, target, config = {} }) {
  const run = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    target: targetSnapshot(target),
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    config,
    events: [],
    obligationGraph: createObligationGraph(target),
  };
  appendProofRunEvent(run, 'run.started', { config });
  return run;
}

function appendProofRunEvent(run, type, payload = {}) {
  if (!run || typeof run !== 'object') {
    throw new Error('appendProofRunEvent requires a proof run object.');
  }
  const event = {
    id: `${run.events.length + 1}-${type}`,
    at: nowIso(),
    type,
    payload: sanitizePayload(payload),
  };
  run.events.push(event);
  run.updatedAt = event.at;
  applyEventToGraph(run.obligationGraph, event);
  return event;
}

function applyEventToGraph(graph, event) {
  if (!graph) return;
  graph.updatedAt = event.at;
  const payload = event.payload || {};
  const text = payload.text || payload.notebook || payload.sketch || payload.knowledge || payload.verdict || '';

  if (event.type === 'knowledge_review.completed') {
    ingestClaimsAndObligations(graph, text, { sourceType: 'knowledge', sourceId: event.id });
  } else if (event.type === 'plan.completed') {
    ingestClaimsAndObligations(graph, text, { sourceType: 'proof_plan', sourceId: event.id });
  } else if (event.type === 'notebook.updated') {
    ingestClaimsAndObligations(graph, text, { sourceType: 'proof_notebook', sourceId: event.id });
    ingestRoutes(graph, text, { sourceType: 'proof_notebook', sourceId: event.id });
    const status = extractTag(text, 'status');
    if (status) graph.status = normalizeGraphStatus(status);
  } else if (event.type === 'research.completed') {
    ingestClaimsAndObligations(graph, text, { sourceType: 'research', sourceId: event.id });
  } else if (event.type === 'source_search.planned') {
    graph.researchRuns[payload.runId || event.id] = {
      id: payload.runId || event.id,
      eventId: event.id,
      stage: payload.stage || null,
      status: 'planned',
      searchPlan: payload.searchPlan || null,
    };
  } else if (event.type === 'source_search.completed' || event.type === 'source_search.failed') {
    const runId = payload.runId || event.id;
    const existing = graph.researchRuns[runId] || { id: runId, eventId: event.id };
    graph.researchRuns[runId] = {
      ...existing,
      eventId: event.id,
      stage: payload.stage || existing.stage || null,
      status: event.type === 'source_search.completed' ? 'completed' : 'failed',
      searchRunPath: payload.searchRunPath || existing.searchRunPath || null,
      sourceCardIds: payload.sourceCardIds || existing.sourceCardIds || [],
      errors: payload.errors || existing.errors || [],
    };
    if (event.type === 'source_search.failed') graph.status = 'needs_more_sources';
  } else if (event.type === 'source_card.created') {
    const card = payload.sourceCard || payload.card || {};
    if (card.id) {
      graph.sourceCards[card.id] = {
        id: card.id,
        eventId: event.id,
        sourceType: card.sourceType || null,
        title: card.title || '',
        url: card.url || '',
        identifiers: card.identifiers || {},
        reliability: card.reliability || 'unknown',
        reviewStatus: card.reviewStatus || 'candidate',
        extractedClaimCount: Array.isArray(card.extractedClaims) ? card.extractedClaims.length : 0,
      };
    }
  } else if (event.type === 'paper_read.completed') {
    const sourceCards = payload.sourceCards || [];
    for (const card of sourceCards) {
      if (!card?.id) continue;
      graph.sourceCards[card.id] = {
        ...(graph.sourceCards[card.id] || {}),
        id: card.id,
        eventId: event.id,
        sourceType: card.sourceType || graph.sourceCards[card.id]?.sourceType || null,
        title: card.title || graph.sourceCards[card.id]?.title || '',
        url: card.url || graph.sourceCards[card.id]?.url || '',
        identifiers: card.identifiers || graph.sourceCards[card.id]?.identifiers || {},
        reliability: card.reliability || graph.sourceCards[card.id]?.reliability || 'unknown',
        reviewStatus: card.reviewStatus || 'read',
        extractedClaimCount: Array.isArray(card.extractedClaims) ? card.extractedClaims.length : 0,
      };
    }
    ingestClaimsAndObligations(graph, payload.text || '', { sourceType: 'paper_read', sourceId: event.id });
  } else if (event.type === 'ledger.proposal.created') {
    const proposal = payload.proposal || {};
    if (proposal.id) {
      graph.ledgerProposals[proposal.id] = {
        id: proposal.id,
        eventId: event.id,
        status: proposal.status || 'proposed',
        tier: proposal.tier || '',
        usePolicy: proposal.usePolicy || '',
        statement: proposal.statement || '',
        sourceRefs: proposal.sourceRefs || '',
      };
    }
  } else if (event.type === 'partial_result.verified') {
    const obligationId = payload.obligationId || payload.selectedObligationIds?.[0] || null;
    const statement = payload.statement || (obligationId && graph.obligations?.[obligationId]?.statement) || '';
    const id = payload.id || `partial:${stableHash(statement || payload.proof || event.id)}`;
    graph.partialResults[id] = {
      id,
      eventId: event.id,
      stage: payload.stage || null,
      obligationId,
      statement,
      proofHash: stableHash(payload.proof || payload.correctedProof || ''),
      verifierVerdict: payload.verdictTag || 'PASS',
      source: payload.source || 'run_verified',
    };
    if (obligationId && graph.obligations?.[obligationId]) {
      graph.obligations[obligationId].status = 'proved';
      graph.obligations[obligationId].tier = 'RUN_VERIFIED';
      graph.obligations[obligationId].usePolicy = 'cite_directly';
    }
    if (graph.status !== 'proved') graph.status = 'partial_progress';
  } else if (event.type === 'attempt.completed') {
    const attemptId = `attempt:${payload.stage || 0}:${payload.index ?? graph.events?.length ?? event.id}:${payload.role || 'unknown'}`;
    graph.attempts[attemptId] = {
      id: attemptId,
      eventId: event.id,
      stage: payload.stage || null,
      index: payload.index ?? null,
      role: payload.role || null,
      proofHash: stableHash(payload.proof || payload.raw || ''),
      proofExcerpt: truncateText(payload.proof || '', 2000),
      targetObligationIds: payload.selectedObligationIds || payload.obligationIds || [],
      status: 'drafted',
    };
    markObligationsAttempted(graph, graph.attempts[attemptId].targetObligationIds, attemptId);
  } else if (event.type === 'verification.completed') {
    const verdictId = `verdict:${payload.stage || 0}:${payload.index ?? event.id}`;
    const verdictTag = cleanVerdictTag(payload.verdictTag || extractVerdict(payload.verdict));
    const targetObligationIds = payload.selectedObligationIds ||
      findAttemptObligationIds(graph, payload.stage, payload.index);
    graph.verdicts[verdictId] = {
      id: verdictId,
      eventId: event.id,
      stage: payload.stage || null,
      attemptIndex: payload.index ?? null,
      role: payload.role || null,
      verdictTag,
      issues: extractIssues(payload.verdict),
      correctedProofHash: payload.correctedProof ? stableHash(payload.correctedProof) : null,
      targetObligationIds,
    };
    updateObligationsFromVerdict(graph, targetObligationIds, verdictTag);
    if (verdictTag === 'PASS' && verdictProvesTarget(payload)) graph.status = 'proved';
  } else if (event.type === 'correction.verified') {
    const verdictTag = cleanVerdictTag(payload.verdictTag || extractVerdict(payload.verdict));
    const targetObligationIds = payload.selectedObligationIds ||
      findAttemptObligationIds(graph, payload.stage, payload.index);
    const verdictId = `verdict:${payload.stage || 0}:${payload.index ?? event.id}:correction`;
    graph.verdicts[verdictId] = {
      id: verdictId,
      eventId: event.id,
      stage: payload.stage || null,
      attemptIndex: payload.index ?? null,
      role: payload.role || null,
      verdictTag,
      issues: extractIssues(payload.verdict),
      correctedProofHash: payload.correctedProof ? stableHash(payload.correctedProof) : null,
      targetObligationIds,
      correction: true,
    };
    updateObligationsFromVerdict(graph, targetObligationIds, verdictTag);
    if (verdictTag === 'PASS' && verdictProvesTarget(payload)) graph.status = 'proved';
  } else if (event.type === 'scheduler.decision') {
    graph.lastSchedulerDecision = payload.decision || payload;
  } else if (event.type === 'run.completed') {
    graph.status = payload.verdictTag === 'PASS' ? 'proved' : (payload.status || 'completed');
  } else if (event.type === 'run.blocked') {
    graph.status = 'blocked';
  }
}

function verdictProvesTarget(payload = {}) {
  const role = String(payload.role || '');
  const index = String(payload.index ?? '');
  return role !== 'subgoal-proof' && !index.startsWith('subgoal-');
}

function normalizeGraphStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key.includes('partial_progress')) return 'partial_progress';
  if (key.includes('needs_more_sources')) return 'needs_more_sources';
  if (key.includes('blocked_with_frontier')) return 'blocked_with_frontier';
  if (key.includes('blocked')) return 'blocked';
  if (key.includes('needs_research')) return 'needs_research';
  if (key.includes('needs_sublemmas')) return 'needs_sublemmas';
  if (key.includes('ready')) return 'ready';
  return key || 'open';
}

function markObligationsAttempted(graph, obligationIds = [], attemptId) {
  for (const id of obligationIds || []) {
    const obligation = graph.obligations?.[id];
    if (!obligation) continue;
    obligation.attempts = mergeUnique(obligation.attempts, [attemptId]);
    if (['open', 'ready', 'needs_sublemmas', 'needs_research', 'pending'].includes(obligation.status || 'open')) {
      obligation.status = 'pending_verification';
    }
  }
}

function updateObligationsFromVerdict(graph, obligationIds = [], verdictTag) {
  for (const id of obligationIds || []) {
    const obligation = graph.obligations?.[id];
    if (!obligation) continue;
    if (verdictTag === 'PASS') {
      obligation.status = 'proved';
    } else if (verdictTag === 'FAIL' || verdictTag === 'NEEDS_REVISION') {
      obligation.status = obligation.usePolicy === 'research_before_use' ? 'needs_research' : 'open';
    }
  }
}

function findAttemptObligationIds(graph, stage, index) {
  const match = Object.values(graph.attempts || {}).find(attempt =>
    String(attempt.stage) === String(stage || null) &&
    String(attempt.index) === String(index ?? null));
  return match?.targetObligationIds || [];
}

function ingestClaimsAndObligations(graph, text, source) {
  for (const item of parseBlocks(text, 'fact')) {
    upsertClaim(graph, item, { ...source, kind: 'fact' });
  }
  for (const item of parseBlocks(text, 'claim')) {
    upsertClaim(graph, item, { ...source, kind: 'claim' });
  }
  for (const item of parseBlocks(text, 'obligation')) {
    upsertObligation(graph, item, source);
  }
}

function ingestRoutes(graph, text, source) {
  for (const item of parseBlocks(text, 'route')) {
    const idea = extractTag(item.body, 'idea') || extractTag(item.body, 'statement') || item.body.trim();
    if (!idea) continue;
    const id = `route:${stableHash(idea)}`;
    const existing = graph.routes[id] || {};
    graph.routes[id] = {
      ...existing,
      id,
      externalIds: mergeUnique(existing.externalIds, [item.attrs.id].filter(Boolean)),
      idea,
      confidence: cleanConfidence(item.attrs.confidence),
      usePolicy: cleanUsePolicy(item.attrs.use_policy || item.attrs.usePolicy),
      whyPromising: extractTag(item.body, 'why_promising'),
      mainRisk: extractTag(item.body, 'main_risk') || extractTag(item.body, 'reason'),
      status: item.attrs.use_policy === 'do_not_use' || source.sourceType.includes('discarded')
        ? 'discarded'
        : (existing.status || 'candidate'),
      provenance: mergeProvenance(existing.provenance, source),
    };
  }
}

function upsertClaim(graph, item, source) {
  const statement = extractTag(item.body, 'statement') || item.body.trim();
  if (!statement) return;
  const id = `claim:${stableHash(statement)}`;
  const existing = graph.claims[id] || {};
  graph.claims[id] = {
    ...existing,
    id,
    externalIds: mergeUnique(existing.externalIds, [item.attrs.id].filter(Boolean)),
    statement,
    tier: cleanTier(item.attrs.tier || existing.tier),
    usePolicy: cleanUsePolicy(item.attrs.use_policy || item.attrs.usePolicy || existing.usePolicy),
    confidence: cleanConfidence(item.attrs.confidence || existing.confidence),
    source: extractTag(item.body, 'source') || existing.source || '',
    conditions: extractTag(item.body, 'conditions') || existing.conditions || '',
    role: extractTag(item.body, 'role') || existing.role || '',
    provenance: mergeProvenance(existing.provenance, source),
  };
}

function upsertObligation(graph, item, source) {
  const statement = extractTag(item.body, 'statement') || item.body.trim();
  if (!statement) return;
  const id = `obl:${stableHash(statement)}`;
  const existing = graph.obligations[id] || {};
  const usePolicy = cleanUsePolicy(item.attrs.use_policy || item.attrs.usePolicy || existing.usePolicy);
  graph.obligations[id] = {
    ...existing,
    id,
    externalIds: mergeUnique(existing.externalIds, [item.attrs.id].filter(Boolean)),
    statement,
    tier: cleanTier(item.attrs.tier || existing.tier || 'T3_LIKELY_PROVABLE'),
    usePolicy,
    confidence: cleanConfidence(item.attrs.confidence || existing.confidence),
    neededFor: extractTag(item.body, 'needed_for') || extractTag(item.body, 'neededFor') || existing.neededFor || '',
    evidence: extractTag(item.body, 'evidence') || existing.evidence || '',
    proofHint: extractTag(item.body, 'proof_hint') || extractTag(item.body, 'proof_strategy') || existing.proofHint || '',
    dependencies: splitList(extractTag(item.body, 'dependencies') || existing.dependencies),
    status: usePolicy === 'do_not_use' ? 'blocked' : (existing.status || 'open'),
    attempts: existing.attempts || [],
    provenance: mergeProvenance(existing.provenance, source),
  };
}

function parseBlocks(text, tagName) {
  const blocks = [];
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  let match;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    blocks.push({
      attrs: parseAttrs(match[1]),
      body: match[2].trim(),
    });
  }
  return blocks;
}

function parseAttrs(text) {
  const attrs = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function extractTag(text, tagName) {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'i');
  const match = String(text || '').match(pattern);
  return match ? match[1].trim() : '';
}

function extractVerdict(text) {
  const body = String(text || '');
  const match = body.match(/<verdict>\s*(PASS|NEEDS_REVISION|FAIL)\s*<\/verdict>/i) ||
    body.match(/<verdict>\s*(PASS|NEEDS_REVISION|FAIL)\b/i);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

function cleanVerdictTag(value) {
  const key = String(value || '').trim().toUpperCase();
  return ['PASS', 'NEEDS_REVISION', 'FAIL'].includes(key) ? key : 'UNKNOWN';
}

function extractIssues(text) {
  const body = extractTag(text, 'issues');
  if (!body) return [];
  return body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && /^[-*]/.test(line))
    .slice(0, 20);
}

function cleanTier(value) {
  return String(value || '').trim() || 'T3_LIKELY_PROVABLE';
}

function cleanUsePolicy(value) {
  const key = String(value || '').trim();
  return key || 'research_before_use';
}

function cleanConfidence(value) {
  const key = String(value || '').trim().toLowerCase();
  return ['high', 'medium', 'low'].includes(key) ? key : 'medium';
}

function splitList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '')
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function mergeUnique(a = [], b = []) {
  return [...new Set([...(a || []), ...(b || []).filter(Boolean)])];
}

function mergeProvenance(existing = [], source = {}) {
  const key = `${source.sourceType || 'unknown'}:${source.sourceId || ''}`;
  const current = existing || [];
  if (current.some(item => `${item.sourceType}:${item.sourceId}` === key)) return current;
  return [...current, {
    sourceType: source.sourceType || 'unknown',
    sourceId: source.sourceId || null,
    kind: source.kind || null,
  }];
}

const USE_POLICY_PRIORITY = {
  prove_inline: 90,
  prove_as_sublemma: 80,
  cite_existing: 55,
  cite_directly: 55,
  research_before_use: 40,
  do_not_use: -100,
};

const CONFIDENCE_PRIORITY = {
  high: 20,
  medium: 10,
  low: 0,
};

const STATUS_PRIORITY = {
  ready: 12,
  open: 10,
  needs_sublemmas: 6,
  needs_research: 2,
  needs_more_sources: 2,
  partial_progress: 5,
  pending: 1,
};

const PROVENANCE_PRIORITY = {
  proof_notebook: 8,
  proof_plan: 6,
  research: 5,
  source_search: 7,
  source_card: 7,
  paper_read: 7,
  partial_result: 10,
  knowledge: 4,
};

function selectOpenObligations(graph, { limit = 3 } = {}) {
  const max = Math.max(0, Number.parseInt(limit, 10) || 0);
  if (!graph || max === 0) return [];

  return Object.values(graph.obligations || {})
    .filter(obligation => isSelectableObligation(obligation))
    .map(obligation => {
      const priority = scoreObligation(obligation);
      return {
        id: obligation.id,
        externalIds: obligation.externalIds || [],
        statement: obligation.statement || '',
        tier: obligation.tier || 'T3_LIKELY_PROVABLE',
        usePolicy: cleanUsePolicy(obligation.usePolicy),
        confidence: cleanConfidence(obligation.confidence),
        neededFor: obligation.neededFor || '',
        evidence: obligation.evidence || '',
        proofHint: obligation.proofHint || '',
        dependencies: obligation.dependencies || [],
        status: obligation.status || 'open',
        provenance: obligation.provenance || [],
        priority,
      };
    })
    .sort((a, b) => b.priority - a.priority || a.statement.localeCompare(b.statement))
    .slice(0, max);
}

function selectCandidateRoutes(graph, { limit = 2 } = {}) {
  const max = Math.max(0, Number.parseInt(limit, 10) || 0);
  if (!graph || max === 0) return [];

  return Object.values(graph.routes || {})
    .filter(route => route.status !== 'discarded' && route.usePolicy !== 'do_not_use')
    .map(route => ({
      id: route.id,
      externalIds: route.externalIds || [],
      idea: route.idea || '',
      confidence: cleanConfidence(route.confidence),
      usePolicy: cleanUsePolicy(route.usePolicy),
      whyPromising: route.whyPromising || '',
      mainRisk: route.mainRisk || '',
      status: route.status || 'candidate',
      provenance: route.provenance || [],
      priority: scoreRoute(route),
    }))
    .sort((a, b) => b.priority - a.priority || a.idea.localeCompare(b.idea))
    .slice(0, max);
}

function buildSchedulerDecision(graph, { stage = null, width = 3 } = {}) {
  const selectedObligations = selectOpenObligations(graph, { limit: Math.max(width, 3) });
  const selectedRoutes = selectCandidateRoutes(graph, { limit: Math.max(1, Math.min(2, width)) });
  const researchCount = selectedObligations.filter(item => item.usePolicy === 'research_before_use').length;
  const provableCount = selectedObligations.filter(item =>
    item.usePolicy === 'prove_inline' || item.usePolicy === 'prove_as_sublemma').length;
  let focus = 'route_search';

  if (graph?.status === 'blocked' && selectedObligations.length === 0) {
    focus = 'blocked';
  } else if (provableCount > 0) {
    focus = 'prove_obligations';
  } else if (researchCount > 0 || graph?.status === 'needs_research') {
    focus = 'research';
  } else if (selectedObligations.length > 0) {
    focus = 'prove_obligations';
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    stage,
    focus,
    graphStatus: graph?.status || 'open',
    selectedObligations,
    selectedRoutes,
    rationale: schedulerRationale(focus, selectedObligations, selectedRoutes),
  };
}

function formatSchedulerDecisionForPrompt(decision = {}) {
  const obligations = (decision.selectedObligations || []).map((item, index) => [
    `    <obligation rank="${index + 1}" id="${escapeXmlAttr(item.id)}" tier="${escapeXmlAttr(item.tier)}" use_policy="${escapeXmlAttr(item.usePolicy)}" confidence="${escapeXmlAttr(item.confidence)}" status="${escapeXmlAttr(item.status)}">`,
    `      <statement>${escapeXmlText(item.statement)}</statement>`,
    item.neededFor ? `      <needed_for>${escapeXmlText(item.neededFor)}</needed_for>` : '',
    item.proofHint ? `      <proof_hint>${escapeXmlText(item.proofHint)}</proof_hint>` : '',
    item.dependencies?.length ? `      <dependencies>${escapeXmlText(item.dependencies.join(' '))}</dependencies>` : '',
    '    </obligation>',
  ].filter(Boolean).join('\n')).join('\n');

  const routes = (decision.selectedRoutes || []).map((item, index) => [
    `    <route rank="${index + 1}" id="${escapeXmlAttr(item.id)}" confidence="${escapeXmlAttr(item.confidence)}" use_policy="${escapeXmlAttr(item.usePolicy)}">`,
    `      <idea>${escapeXmlText(item.idea)}</idea>`,
    item.whyPromising ? `      <why_promising>${escapeXmlText(item.whyPromising)}</why_promising>` : '',
    item.mainRisk ? `      <main_risk>${escapeXmlText(item.mainRisk)}</main_risk>` : '',
    '    </route>',
  ].filter(Boolean).join('\n')).join('\n');

  return [
    `<scheduler_decision stage="${escapeXmlAttr(decision.stage ?? '')}" focus="${escapeXmlAttr(decision.focus || 'route_search')}" graph_status="${escapeXmlAttr(decision.graphStatus || 'open')}">`,
    `  <rationale>${escapeXmlText(decision.rationale || '')}</rationale>`,
    '  <selected_obligations>',
    obligations || '    <none />',
    '  </selected_obligations>',
    '  <selected_routes>',
    routes || '    <none />',
    '  </selected_routes>',
    '</scheduler_decision>',
  ].join('\n');
}

function isSelectableObligation(obligation = {}) {
  const status = String(obligation.status || 'open').trim().toLowerCase();
  const usePolicy = cleanUsePolicy(obligation.usePolicy);
  if (usePolicy === 'do_not_use') return false;
  return ['open', 'ready', 'needs_sublemmas', 'needs_research', 'pending'].includes(status);
}

function scoreObligation(obligation = {}) {
  const usePolicy = cleanUsePolicy(obligation.usePolicy);
  const status = String(obligation.status || 'open').trim().toLowerCase();
  const provenanceBoost = Math.max(0, ...(obligation.provenance || []).map(item =>
    PROVENANCE_PRIORITY[item.sourceType] || 0));
  return (USE_POLICY_PRIORITY[usePolicy] ?? 30) +
    (CONFIDENCE_PRIORITY[cleanConfidence(obligation.confidence)] ?? 0) +
    (STATUS_PRIORITY[status] ?? 0) +
    provenanceBoost;
}

function scoreRoute(route = {}) {
  const provenanceBoost = Math.max(0, ...(route.provenance || []).map(item =>
    PROVENANCE_PRIORITY[item.sourceType] || 0));
  return (CONFIDENCE_PRIORITY[cleanConfidence(route.confidence)] ?? 0) +
    ((route.status || 'candidate') === 'candidate' ? 8 : 0) +
    provenanceBoost;
}

function schedulerRationale(focus, obligations, routes) {
  if (focus === 'blocked') {
    return 'No selectable proof obligation remains; the run should report a blocked state instead of inventing a proof.';
  }
  if (focus === 'research') {
    return 'The highest-priority remaining items require source support before they can be used in a proof.';
  }
  if (focus === 'prove_obligations') {
    return `Attack ${obligations.length} explicit obligation(s) before using their statements in the target proof.`;
  }
  return `No dominant obligation was selected; explore ${routes.length} candidate route(s) while preserving use-policy constraints.`;
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

function persistProofRunArtifacts(run, fermatDir) {
  if (!fermatDir) return null;
  const runsDir = path.join(fermatDir, 'runs');
  const obligationsDir = path.join(fermatDir, 'obligations');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(obligationsDir, { recursive: true });

  const runPath = path.join(runsDir, `${run.runId}.json`);
  const graphPath = path.join(obligationsDir, `${targetKey(run.target)}.json`);
  fs.writeFileSync(runPath, JSON.stringify(run, null, 2));
  fs.writeFileSync(graphPath, JSON.stringify(run.obligationGraph, null, 2));
  return { runPath, graphPath };
}

module.exports = {
  SCHEMA_VERSION,
  appendProofRunEvent,
  buildSchedulerDecision,
  createObligationGraph,
  createProofRun,
  extractTag,
  formatSchedulerDecisionForPrompt,
  parseBlocks,
  persistProofRunArtifacts,
  selectCandidateRoutes,
  selectOpenObligations,
  stableHash,
  targetKey,
  targetSnapshot,
  truncateText,
};
