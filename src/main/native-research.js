const fs = require('fs');
const https = require('https');
const path = require('path');
const { normalizeSourceCard, stableHash } = require('./source-store');

const SEARCH_SCHEMA_VERSION = 1;
const DEFAULT_PROVIDERS = ['arxiv', 'crossref', 'local_bib', 'local_pdf', 'project_web'];

function nowIso() {
  return new Date().toISOString();
}

function createResearchRun({ runId, target, searchPlan, providers, budget } = {}) {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    runId: runId || `search-${Date.now()}-${stableHash(target?.name || target?.id || 'target')}`,
    target: target || null,
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    providers,
    budget,
    searchPlan,
    queries: [],
    results: [],
    sourceCards: [],
    errors: [],
  };
}

function persistResearchRun(run, fermatDir) {
  if (!fermatDir) return null;
  const dir = path.join(fermatDir, 'search-runs');
  fs.mkdirSync(dir, { recursive: true });
  run.updatedAt = nowIso();
  const filePath = path.join(dir, `${run.runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(run, null, 2));
  return filePath;
}

function normalizeSearchPlan(rawPlan = {}, { target = {}, obligations = [], providers = DEFAULT_PROVIDERS, budget = {} } = {}) {
  const queries = Array.isArray(rawPlan.queries) ? rawPlan.queries : [];
  const fallbackQuery = [
    target.name,
    target.labels?.[0],
    obligations[0]?.statement,
  ].filter(Boolean).join(' ');
  const normalizedQueries = (queries.length ? queries : [{
    id: 'q-fallback',
    provider: 'arxiv',
    query: fallbackQuery || 'mathematics theorem',
    expectedClaim: obligations[0]?.statement || '',
    obligations: obligations.slice(0, 3).map(item => item.id).filter(Boolean),
    priority: 1,
  }]).map((item, index) => ({
    id: String(item.id || `q-${index + 1}`),
    provider: normalizeProvider(item.provider || item.source || 'arxiv'),
    query: String(item.query || fallbackQuery || '').trim(),
    expectedClaim: String(item.expectedClaim || item.expected_claim || item.claim || '').trim(),
    obligations: Array.isArray(item.obligations) ? item.obligations : [],
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : index + 1,
    urls: Array.isArray(item.urls) ? item.urls : [],
  })).filter(item => item.query || item.urls.length);

  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    target: rawPlan.target || {
      id: target.id || null,
      name: target.name || null,
      labels: target.labels || [],
    },
    providers: normalizeProviders(rawPlan.providers || providers),
    budget: {
      maxResultsPerQuery: boundedInt(rawPlan.budget?.maxResultsPerQuery ?? budget.maxResultsPerQuery, 3, 1, 8),
      maxSources: boundedInt(rawPlan.budget?.maxSources ?? budget.maxSources, 6, 1, 20),
    },
    queries: normalizedQueries,
    rationale: String(rawPlan.rationale || '').trim(),
  };
}

async function runNativeSourceSearch(searchPlan, options = {}) {
  const providers = normalizeProviders(options.providers || searchPlan.providers || DEFAULT_PROVIDERS);
  const budget = {
    maxResultsPerQuery: boundedInt(options.budget?.maxResultsPerQuery || searchPlan.budget?.maxResultsPerQuery, 3, 1, 8),
    maxSources: boundedInt(options.budget?.maxSources || searchPlan.budget?.maxSources, 6, 1, 20),
  };
  const run = createResearchRun({
    runId: options.runId,
    target: searchPlan.target,
    searchPlan,
    providers,
    budget,
  });

  const cards = [];
  for (const query of searchPlan.queries || []) {
    if (!providers.includes(query.provider)) continue;
    run.queries.push(query);
    try {
      let results = [];
      if (query.provider === 'arxiv') {
        results = await searchArxiv(query.query, { maxResults: budget.maxResultsPerQuery, fetchText: options.fetchText });
      } else if (query.provider === 'crossref') {
        results = await searchCrossref(query.query, { maxResults: budget.maxResultsPerQuery, fetchJson: options.fetchJson });
      } else if (query.provider === 'local_bib') {
        results = searchLocalBib(options.projectDir || path.dirname(options.filePath || process.cwd()), query.query, {
          maxResults: budget.maxResultsPerQuery,
        });
      } else if (query.provider === 'local_pdf') {
        results = searchLocalPdfs(options.projectDir || path.dirname(options.filePath || process.cwd()), query.query, {
          maxResults: budget.maxResultsPerQuery,
        });
      } else if (query.provider === 'project_web') {
        results = await searchProjectWeb(query, { maxResults: budget.maxResultsPerQuery, fetchText: options.fetchText });
      }
      for (const result of results) {
        const card = normalizeSourceCard({
          ...result,
          relevance: result.relevance || query.expectedClaim || query.query,
        });
        cards.push(card);
        run.results.push({ queryId: query.id, provider: query.provider, sourceId: card.id, title: card.title, url: card.url });
      }
    } catch (err) {
      run.errors.push({ queryId: query.id, provider: query.provider, message: err.message });
    }
    if (cards.length >= budget.maxSources) break;
  }

  run.sourceCards = dedupeCards(cards).slice(0, budget.maxSources);
  run.status = run.errors.length && run.sourceCards.length === 0 ? 'failed' : 'completed';
  run.updatedAt = nowIso();
  return run;
}

async function searchArxiv(query, { maxResults = 3, fetchText = fetchTextUrl } = {}) {
  if (!query) return [];
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(maxResults),
    sortBy: 'relevance',
    sortOrder: 'descending',
  });
  const url = `https://export.arxiv.org/api/query?${params.toString()}`;
  const xml = await fetchText(url);
  return parseArxivAtom(xml);
}

function parseArxivAtom(xml) {
  return [...String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => {
    const entry = match[1];
    const idUrl = stripXml(firstTag(entry, 'id'));
    const arxivId = (idUrl.match(/abs\/([^/?#]+)/) || [])[1] || '';
    return {
      sourceType: 'arxiv',
      provider: 'arxiv',
      title: stripXml(firstTag(entry, 'title')),
      authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g)].map(a => stripXml(a[1])),
      year: stripXml(firstTag(entry, 'published')).slice(0, 4),
      url: idUrl,
      identifiers: { arxiv: arxivId },
      abstract: stripXml(firstTag(entry, 'summary')),
      reliability: 'primary_source',
    };
  }).filter(item => item.title);
}

async function searchCrossref(query, { maxResults = 3, fetchJson = fetchJsonUrl } = {}) {
  if (!query) return [];
  const params = new URLSearchParams({
    query,
    rows: String(maxResults),
  });
  const json = await fetchJson(`https://api.crossref.org/works?${params.toString()}`);
  return parseCrossrefWorks(json);
}

function parseCrossrefWorks(json) {
  const items = json?.message?.items || [];
  return items.map(item => {
    const year = item.issued?.['date-parts']?.[0]?.[0] || item.published?.['date-parts']?.[0]?.[0] || '';
    return {
      sourceType: 'doi',
      provider: 'crossref',
      title: Array.isArray(item.title) ? item.title[0] : item.title,
      authors: (item.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
      year: String(year || ''),
      url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''),
      identifiers: { doi: item.DOI || '' },
      abstract: stripJats(item.abstract || ''),
      reliability: 'primary_source',
    };
  }).filter(item => item.title);
}

function searchLocalBib(projectDir, query, { maxResults = 3 } = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const files = findFiles(root, name => name.endsWith('.bib'), { maxFiles: 40, maxDepth: 5 });
  const tokens = queryTokens(query);
  const entries = [];
  for (const file of files) {
    const text = safeRead(file, 2_000_000);
    for (const entry of parseBibEntries(text)) {
      const haystack = [entry.title, entry.author, entry.year, entry.doi, entry.eprint, entry.key].join(' ').toLowerCase();
      const score = tokens.filter(token => haystack.includes(token)).length;
      if (score === 0 && tokens.length) continue;
      entries.push({
        sourceType: 'local_bib',
        provider: 'local_bib',
        title: entry.title || entry.key,
        authors: entry.author ? entry.author.split(/\s+and\s+/i).map(s => s.trim()) : [],
        year: entry.year || '',
        url: entry.url || (entry.doi ? `https://doi.org/${entry.doi}` : ''),
        identifiers: { doi: entry.doi || '', arxiv: entry.eprint || '', bibKey: entry.key || '' },
        abstract: '',
        reliability: 'secondary_source',
        relevance: `Matched local bibliography ${path.relative(root, file)}`,
        _score: score,
      });
    }
  }
  return entries.sort((a, b) => b._score - a._score).slice(0, maxResults).map(({ _score, ...item }) => item);
}

function parseBibEntries(text) {
  const entries = [];
  const pattern = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@|\s*$)/g;
  let match;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    const fields = {};
    const fieldPattern = /(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^,\n]+)\s*,?/g;
    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(match[3])) !== null) {
      fields[fieldMatch[1].toLowerCase()] = cleanBibValue(fieldMatch[2]);
    }
    entries.push({ type: match[1], key: match[2], ...fields });
  }
  return entries;
}

function searchLocalPdfs(projectDir, query, { maxResults = 3 } = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const tokens = queryTokens(query);
  return findFiles(root, name => /\.pdf$/i.test(name), { maxFiles: 80, maxDepth: 5 })
    .map(file => {
      const title = path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ');
      const haystack = title.toLowerCase();
      const score = tokens.filter(token => haystack.includes(token)).length;
      return { file, title, score };
    })
    .filter(item => item.score > 0 || tokens.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => ({
      sourceType: 'local_pdf',
      provider: 'local_pdf',
      title: item.title,
      authors: [],
      year: '',
      url: item.file,
      identifiers: {},
      abstract: '',
      reliability: 'primary_source',
      relevance: `Matched local PDF ${path.relative(root, item.file)}`,
    }));
}

async function searchProjectWeb(query, { maxResults = 3, fetchText = fetchTextUrl } = {}) {
  const urls = (query.urls || []).filter(url => /^https?:\/\//i.test(url)).slice(0, maxResults);
  const cards = [];
  for (const url of urls) {
    const text = await fetchText(url);
    cards.push({
      sourceType: 'web',
      provider: 'project_web',
      title: htmlTitle(text) || url,
      authors: [],
      year: '',
      url,
      identifiers: {},
      abstract: htmlText(text).slice(0, 4000),
      reliability: 'secondary_source',
      relevance: query.expectedClaim || query.query || '',
    });
  }
  return cards;
}

function dedupeCards(cards) {
  const seen = new Map();
  for (const card of cards || []) {
    const key = card.identifiers?.arxiv || card.identifiers?.doi || card.url || card.title;
    if (!seen.has(key)) seen.set(key, card);
  }
  return [...seen.values()];
}

function normalizeProviders(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const providers = raw.map(normalizeProvider).filter(Boolean);
  return providers.length ? [...new Set(providers)] : DEFAULT_PROVIDERS;
}

function normalizeProvider(value) {
  const key = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (key === 'doi') return 'crossref';
  if (DEFAULT_PROVIDERS.includes(key)) return key;
  return 'arxiv';
}

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function firstTag(text, tagName) {
  const match = String(text || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1] : '';
}

function stripXml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripJats(value) {
  return stripXml(value);
}

function cleanBibValue(value) {
  return String(value || '')
    .trim()
    .replace(/^["{]+|["}]+$/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

function htmlTitle(html) {
  return stripXml(firstTag(html, 'title'));
}

function htmlText(html) {
  return stripXml(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''));
}

function queryTokens(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 4)
    .slice(0, 20);
}

function findFiles(root, predicate, { maxFiles = 100, maxDepth = 5 } = {}) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'release', '.lake']);
  function walk(dir, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile() && predicate(entry.name, full)) {
        out.push(full);
      }
    }
  }
  walk(root, 0);
  return out;
}

function safeRead(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) return fs.readFileSync(filePath, 'utf-8').slice(0, maxBytes);
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function fetchTextUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Fermat native research (https://github.com/dangxingyu/fermat)' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchTextUrl(new URL(res.headers.location, url).toString()));
        res.resume();
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`GET ${url} failed with HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function fetchJsonUrl(url) {
  return JSON.parse(await fetchTextUrl(url));
}

module.exports = {
  DEFAULT_PROVIDERS,
  SEARCH_SCHEMA_VERSION,
  createResearchRun,
  normalizeSearchPlan,
  parseArxivAtom,
  parseBibEntries,
  parseCrossrefWorks,
  persistResearchRun,
  runNativeSourceSearch,
  searchLocalBib,
  searchLocalPdfs,
};
