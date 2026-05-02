const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const AUDIT_FILE = path.join('.fermat', 'outline-audit.json');

const USE_POLICIES = new Set([
  'cite_existing',
  'cite_directly',
  'prove_inline',
  'prove_as_sublemma',
  'research_before_use',
  'do_not_use',
]);
const CONFIDENCE = new Set(['high', 'medium', 'low']);

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function normalizeStatement(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function documentHash(content) {
  return stableHash(content);
}

function statementHashForNode(node) {
  if (node?.statementHash) return node.statementHash;
  return stableHash(normalizeStatement(node?.statementTeX || node?.name || ''));
}

function nodeAuditKey(node) {
  const firstLabel = node?.labels?.[0];
  if (firstLabel) return `label:${firstLabel}`;
  return `span:${node?.lineNumber || 0}:${statementHashForNode(node)}`;
}

function resolveAuditPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;

  let dir = path.dirname(path.resolve(filePath));
  let fallback = dir;
  for (let depth = 0; depth < 10; depth++) {
    if (fs.existsSync(path.join(dir, '.fermat')) || fs.existsSync(path.join(dir, '.git'))) {
      return path.join(dir, AUDIT_FILE);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(fallback, AUDIT_FILE);
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('Outline audit did not contain a JSON object.');
  }
  return JSON.parse(body.slice(start, end + 1));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value == null ? '' : String(value);
}

function cleanUsePolicy(value) {
  const policy = asString(value).trim();
  if (USE_POLICIES.has(policy)) return policy;
  return 'research_before_use';
}

function cleanConfidence(value) {
  const confidence = asString(value).trim().toLowerCase();
  if (CONFIDENCE.has(confidence)) return confidence;
  return 'medium';
}

function cleanSuggestion(item = {}) {
  return {
    targetLabel: asString(item.targetLabel || item.target_label).trim(),
    statement: asString(item.statement || item.claim).trim(),
    confidence: cleanConfidence(item.confidence),
    reason: asString(item.reason || item.evidence).trim(),
    usePolicy: cleanUsePolicy(item.usePolicy || item.use_policy),
  };
}

function cleanObligation(item = {}) {
  return {
    statement: asString(item.statement || item.claim).trim(),
    tier: asString(item.tier || 'T3_LIKELY_PROVABLE').trim(),
    usePolicy: cleanUsePolicy(item.usePolicy || item.use_policy),
    confidence: cleanConfidence(item.confidence),
    neededFor: asString(item.neededFor || item.needed_for || item.reason).trim(),
  };
}

function cleanWarning(item = {}) {
  return {
    statement: asString(item.statement || item.claim || item.message).trim(),
    tier: asString(item.tier || '').trim(),
    reason: asString(item.reason || item.evidence).trim(),
  };
}

function cleanMissingCitation(item = {}) {
  return {
    statement: asString(item.statement || item.claim).trim(),
    suggestedLabel: asString(item.suggestedLabel || item.suggested_label || item.targetLabel || item.target_label).trim(),
    confidence: cleanConfidence(item.confidence),
    reason: asString(item.reason || item.evidence).trim(),
    usePolicy: cleanUsePolicy(item.usePolicy || item.use_policy || 'cite_existing'),
  };
}

function indexRawNodes(rawNodes) {
  const indexed = new Map();
  if (Array.isArray(rawNodes)) {
    for (const node of rawNodes) {
      const key = node?.nodeKey || node?.key || node?.id;
      if (key) indexed.set(String(key), node);
    }
    return indexed;
  }
  if (rawNodes && typeof rawNodes === 'object') {
    for (const [key, node] of Object.entries(rawNodes)) {
      indexed.set(key, node);
    }
  }
  return indexed;
}

function normalizeOutlineAudit(rawAudit, { outline, texContent, filePath }) {
  const rawNodes = indexRawNodes(rawAudit?.nodes);
  const nodes = {};
  const theoremNodes = (outline?.nodes || []).filter(n => n.type !== 'section');

  for (const node of theoremNodes) {
    const key = nodeAuditKey(node);
    const rawNode = rawNodes.get(key) || {};
    const suggestionSource = rawNode.suggestedDependencies || rawNode.suggested_dependencies;
    const missingSource = rawNode.missingCitations || rawNode.missing_citations;
    const obligationSource = rawNode.proofObligations || rawNode.proof_obligations;

    nodes[key] = {
      nodeKey: key,
      statementHash: statementHashForNode(node),
      status: 'fresh',
      type: node.type,
      name: node.name || '',
      labels: node.labels || [],
      lineNumber: node.lineNumber,
      suggestedDependencies: asArray(suggestionSource)
        .map(cleanSuggestion)
        .filter(item => item.statement || item.targetLabel),
      missingCitations: asArray(missingSource)
        .map(cleanMissingCitation)
        .filter(item => item.statement || item.suggestedLabel),
      proofObligations: asArray(obligationSource)
        .map(cleanObligation)
        .filter(item => item.statement),
      warnings: asArray(rawNode.warnings)
        .map(cleanWarning)
        .filter(item => item.statement || item.reason),
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    documentHash: documentHash(texContent),
    filePath: filePath || null,
    updatedAt: new Date().toISOString(),
    nodes,
  };
}

function markAuditFreshness(audit, { outline, texContent, filePath } = {}) {
  if (!audit || typeof audit !== 'object') return null;

  const nodes = {};
  const currentByKey = new Map();
  for (const node of (outline?.nodes || []).filter(n => n.type !== 'section')) {
    currentByKey.set(nodeAuditKey(node), {
      hash: statementHashForNode(node),
      type: node.type,
      name: node.name || '',
      labels: node.labels || [],
      lineNumber: node.lineNumber,
    });
  }

  for (const [key, node] of Object.entries(audit.nodes || {})) {
    const current = currentByKey.get(key);
    const status = current && node.statementHash === current.hash ? 'fresh' : 'stale';
    nodes[key] = {
      ...node,
      ...(current || {}),
      nodeKey: key,
      status,
    };
  }

  return {
    ...audit,
    schemaVersion: audit.schemaVersion || SCHEMA_VERSION,
    filePath: filePath || audit.filePath || null,
    currentDocumentHash: texContent ? documentHash(texContent) : audit.currentDocumentHash,
    isStale: texContent ? audit.documentHash !== documentHash(texContent) : !!audit.isStale,
    nodes,
  };
}

function loadOutlineAudit({ filePath, texContent, outline } = {}) {
  const auditPath = resolveAuditPath(filePath);
  if (!auditPath || !fs.existsSync(auditPath)) return null;

  const parsed = JSON.parse(fs.readFileSync(auditPath, 'utf-8'));
  return {
    ...markAuditFreshness(parsed, { outline, texContent, filePath }),
    auditPath,
  };
}

function saveOutlineAudit(audit, filePath) {
  const auditPath = resolveAuditPath(filePath);
  if (!auditPath) {
    throw new Error('Cannot save outline audit without a file path.');
  }
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf-8');
  return auditPath;
}

function compactNodeForPrompt(node, outline) {
  const outgoing = (outline?.edges || [])
    .filter(edge => edge.from === node.id)
    .map(edge => {
      const target = outline.nodes.find(n => n.id === edge.to);
      return {
        label: edge.label || '',
        targetKey: target ? nodeAuditKey(target) : '',
        targetLabel: target?.labels?.[0] || edge.label || '',
        targetName: target?.name || '',
      };
    });

  return {
    key: nodeAuditKey(node),
    type: node.type,
    name: node.name || '',
    labels: node.labels || [],
    lineNumber: node.lineNumber,
    statementHash: statementHashForNode(node),
    statementTeX: node.statementTeX || '',
    explicitRefs: node.refs || [],
    citedDependencies: outgoing,
    hasProof: !!node.hasProof,
  };
}

function buildOutlineAuditPrompt({ outline, texContent, filePath, knowledgeLedger }) {
  const theoremNodes = (outline?.nodes || []).filter(n => n.type !== 'section');
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    document: {
      filePath: filePath || null,
      documentHash: documentHash(texContent),
    },
    nodes: theoremNodes.map(node => compactNodeForPrompt(node, outline)),
    staticEdges: outline?.edges || [],
  };

  const sections = [
    '<outline_audit_request>',
    JSON.stringify(payload, null, 2),
    '</outline_audit_request>',
  ];

  if (knowledgeLedger?.content) {
    sections.push(
      `<knowledge_ledger path="${escapeXmlAttr(knowledgeLedger.path || '')}"${knowledgeLedger.truncated ? ' truncated="true"' : ''}>`,
      knowledgeLedger.content,
      '</knowledge_ledger>',
    );
  }

  sections.push('<full_document>', texContent || '', '</full_document>');
  return sections.join('\n');
}

function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  SCHEMA_VERSION,
  stableHash,
  documentHash,
  statementHashForNode,
  nodeAuditKey,
  resolveAuditPath,
  extractJsonObject,
  normalizeOutlineAudit,
  markAuditFreshness,
  loadOutlineAudit,
  saveOutlineAudit,
  buildOutlineAuditPrompt,
};
