const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE_SCHEMA_VERSION = 1;
const MAX_TEXT = 20_000;

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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function cleanText(value, max = MAX_TEXT) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)} [FERMAT: truncated ${text.length - max} chars]`;
}

function cleanIdentifier(value) {
  return String(value || '').trim();
}

function normalizeSourceType(value) {
  const key = String(value || '').trim().toLowerCase();
  if (['arxiv', 'doi', 'crossref', 'web', 'local_pdf', 'local_bib', 'bibtex', 'manual'].includes(key)) {
    return key;
  }
  return 'manual';
}

function normalizeReliability(value, sourceType) {
  const key = String(value || '').trim().toLowerCase();
  if (['primary_source', 'secondary_source', 'notes', 'unknown'].includes(key)) return key;
  if (sourceType === 'arxiv' || sourceType === 'doi' || sourceType === 'crossref') return 'primary_source';
  if (sourceType === 'local_bib' || sourceType === 'bibtex') return 'secondary_source';
  return 'unknown';
}

function sourceIdentity(candidate = {}) {
  const ids = candidate.identifiers || {};
  return [
    ids.arxiv && `arxiv:${ids.arxiv}`,
    ids.doi && `doi:${ids.doi}`,
    ids.bibKey && `bib:${ids.bibKey}`,
    candidate.url && `url:${candidate.url}`,
    candidate.title && `title:${candidate.title}`,
  ].filter(Boolean)[0] || JSON.stringify(candidate).slice(0, 500);
}

function normalizeSourceCard(candidate = {}) {
  const sourceType = normalizeSourceType(candidate.sourceType || candidate.type || candidate.provider);
  const identifiers = {
    arxiv: cleanIdentifier(candidate.identifiers?.arxiv || candidate.arxivId || ''),
    doi: cleanIdentifier(candidate.identifiers?.doi || candidate.doi || ''),
    bibKey: cleanIdentifier(candidate.identifiers?.bibKey || candidate.bibKey || ''),
  };
  const id = candidate.id || `src-${stableHash(sourceIdentity({ ...candidate, identifiers }))}`;
  const title = cleanText(candidate.title || candidate.name || 'Untitled source', 500);
  const card = {
    schemaVersion: SOURCE_SCHEMA_VERSION,
    id,
    sourceType,
    provider: cleanIdentifier(candidate.provider || sourceType),
    title,
    authors: asArray(candidate.authors).map(a => cleanText(a, 200)).filter(Boolean).slice(0, 30),
    year: cleanIdentifier(candidate.year || candidate.publishedYear || candidate.issued || ''),
    url: cleanIdentifier(candidate.url || ''),
    identifiers,
    abstract: cleanText(candidate.abstract || candidate.summary || '', 8000),
    reliability: normalizeReliability(candidate.reliability, sourceType),
    reviewStatus: cleanIdentifier(candidate.reviewStatus || candidate.status || 'candidate') || 'candidate',
    relevance: cleanText(candidate.relevance || candidate.reason || '', 2000),
    extractedClaims: asArray(candidate.extractedClaims || candidate.claims).map(normalizeClaim).filter(c => c.statement),
    openQuestions: asArray(candidate.openQuestions).map(q => cleanText(q, 1000)).filter(Boolean),
    sourceHash: stableHash([
      sourceType,
      title,
      identifiers.arxiv,
      identifiers.doi,
      identifiers.bibKey,
      candidate.url || '',
      candidate.abstract || '',
    ].join('\n')),
    reviewedAt: candidate.reviewedAt || null,
    updatedAt: nowIso(),
  };
  return card;
}

function normalizeClaim(item = {}) {
  if (typeof item === 'string') {
    return {
      id: `claim-${stableHash(item)}`,
      statement: cleanText(item, 2000),
      conditions: '',
      sourceRef: '',
      tier: 'T1_SOURCE_BACKED',
      usePolicy: 'cite_directly',
      conditionMatch: 'unknown',
    };
  }
  const statement = cleanText(item.statement || item.claim || '', 2000);
  return {
    id: item.id || `claim-${stableHash(statement)}`,
    statement,
    conditions: cleanText(item.conditions || '', 2000),
    sourceRef: cleanText(item.sourceRef || item.source_ref || item.location || '', 500),
    tier: cleanIdentifier(item.tier || 'T1_SOURCE_BACKED'),
    usePolicy: cleanIdentifier(item.usePolicy || item.use_policy || 'cite_directly'),
    conditionMatch: cleanIdentifier(item.conditionMatch || item.condition_match || 'unknown') || 'unknown',
    relevance: cleanText(item.relevance || '', 1000),
  };
}

function resolveFermatDir({ filePath, projectDir } = {}) {
  const startDirs = [];
  if (projectDir) startDirs.push(projectDir);
  if (filePath) startDirs.push(path.dirname(filePath));
  if (startDirs.length === 0) return null;

  for (const start of startDirs) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 8; depth++) {
      if (fs.existsSync(path.join(dir, '.fermat')) || fs.existsSync(path.join(dir, '.git'))) {
        const fermatDir = path.join(dir, '.fermat');
        fs.mkdirSync(fermatDir, { recursive: true });
        return fermatDir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const fallback = path.join(path.resolve(startDirs[0]), '.fermat');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

class SourceStore {
  constructor(fermatDir) {
    if (!fermatDir) throw new Error('SourceStore requires a .fermat directory.');
    this.fermatDir = fermatDir;
    this.sourcesDir = path.join(fermatDir, 'sources');
    fs.mkdirSync(this.sourcesDir, { recursive: true });
  }

  cardPath(id) {
    const safe = String(id || '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
    if (!safe) throw new Error('source card id is required');
    return path.join(this.sourcesDir, `${safe}.json`);
  }

  saveCard(candidate) {
    const incoming = normalizeSourceCard(candidate);
    const existing = this.openCard(incoming.id);
    const merged = existing ? mergeSourceCards(existing, incoming) : incoming;
    fs.writeFileSync(this.cardPath(merged.id), JSON.stringify(merged, null, 2));
    return merged;
  }

  saveCards(candidates = []) {
    return candidates.map(item => this.saveCard(item));
  }

  openCard(id) {
    if (!id) return null;
    const filePath = this.cardPath(id);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  listCards() {
    if (!fs.existsSync(this.sourcesDir)) return [];
    return fs.readdirSync(this.sourcesDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.sourcesDir, name), 'utf-8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
}

function mergeSourceCards(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    authors: existing.authors?.length ? existing.authors : incoming.authors,
    abstract: incoming.abstract || existing.abstract || '',
    relevance: incoming.relevance || existing.relevance || '',
    extractedClaims: mergeClaims(existing.extractedClaims, incoming.extractedClaims),
    openQuestions: [...new Set([...(existing.openQuestions || []), ...(incoming.openQuestions || [])])],
    reviewStatus: incoming.reviewStatus === 'candidate' && existing.reviewStatus ? existing.reviewStatus : incoming.reviewStatus,
    reviewedAt: incoming.reviewedAt || existing.reviewedAt || null,
    updatedAt: nowIso(),
  };
}

function mergeClaims(a = [], b = []) {
  const byId = new Map();
  for (const item of [...(a || []), ...(b || [])]) {
    const claim = normalizeClaim(item);
    if (!claim.statement) continue;
    byId.set(claim.id || `claim-${stableHash(claim.statement)}`, { ...(byId.get(claim.id) || {}), ...claim });
  }
  return [...byId.values()];
}

function formatSourceCardsForPrompt(cards = [], { maxCards = 8 } = {}) {
  const selected = (cards || []).slice(0, maxCards);
  if (selected.length === 0) return '<source_cards>\n  <none />\n</source_cards>';
  const body = selected.map(card => [
    `  <source_card id="${escapeXmlAttr(card.id)}" type="${escapeXmlAttr(card.sourceType)}" reliability="${escapeXmlAttr(card.reliability)}" review_status="${escapeXmlAttr(card.reviewStatus)}">`,
    `    <title>${escapeXmlText(card.title)}</title>`,
    card.authors?.length ? `    <authors>${escapeXmlText(card.authors.join('; '))}</authors>` : '',
    card.year ? `    <year>${escapeXmlText(card.year)}</year>` : '',
    card.url ? `    <url>${escapeXmlText(card.url)}</url>` : '',
    card.identifiers?.arxiv ? `    <arxiv>${escapeXmlText(card.identifiers.arxiv)}</arxiv>` : '',
    card.identifiers?.doi ? `    <doi>${escapeXmlText(card.identifiers.doi)}</doi>` : '',
    card.abstract ? `    <abstract>${escapeXmlText(card.abstract.slice(0, 4000))}</abstract>` : '',
    card.relevance ? `    <relevance>${escapeXmlText(card.relevance)}</relevance>` : '',
    ...(card.extractedClaims || []).slice(0, 6).map(claim => [
      `    <claim id="${escapeXmlAttr(claim.id)}" tier="${escapeXmlAttr(claim.tier)}" use_policy="${escapeXmlAttr(claim.usePolicy)}" condition_match="${escapeXmlAttr(claim.conditionMatch)}">`,
      `      <statement>${escapeXmlText(claim.statement)}</statement>`,
      claim.conditions ? `      <conditions>${escapeXmlText(claim.conditions)}</conditions>` : '',
      claim.sourceRef ? `      <source_ref>${escapeXmlText(claim.sourceRef)}</source_ref>` : '',
      '    </claim>',
    ].filter(Boolean).join('\n')),
    '  </source_card>',
  ].filter(Boolean).join('\n')).join('\n');
  return `<source_cards>\n${body}\n</source_cards>`;
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
  SOURCE_SCHEMA_VERSION,
  SourceStore,
  cleanText,
  formatSourceCardsForPrompt,
  normalizeSourceCard,
  resolveFermatDir,
  stableHash,
};
