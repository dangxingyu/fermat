#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { ClaudeCodeBackend } = require('../src/main/claude-code-backend');
const { parseTheoryOutline } = require('../src/main/outline-parser');

const META_URL = 'https://raw.githubusercontent.com/teorth/erdosproblems/main/data/problems.yaml';
const PROBLEM_BASE = 'https://www.erdosproblems.com';
const DEFAULT_OUT_DIR = 'fermat-skills-workspace/erdos-max';

function parseArgs(argv) {
  const args = {
    status: 'open',
    limit: 10,
    outDir: DEFAULT_OUT_DIR,
    tex: true,
    attemptLimit: 0,
    runner: 'fermat-max',
    effort: 'xhigh',
    model: 'sonnet',
    maxBudgetUsd: '1.00',
    includeNotes: true,
    mode: 'triage',
    maxWidth: 2,
    maxStages: 1,
    skipVerify: false,
    delayMs: 250,
    timeoutMs: 10 * 60 * 1000,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--status') args.status = next, i++;
    else if (arg === '--limit') args.limit = Number(next), i++;
    else if (arg === '--out-dir') args.outDir = next, i++;
    else if (arg === '--problem') args.problems = next.split(',').map(s => s.trim()).filter(Boolean), i++;
    else if (arg === '--tag') args.tag = next, i++;
    else if (arg === '--formalized') args.formalized = next, i++;
    else if (arg === '--no-tex') args.tex = false;
    else if (arg === '--attempt-limit') args.attemptLimit = Number(next), i++;
    else if (arg === '--runner') args.runner = next, i++;
    else if (arg === '--effort') args.effort = next, i++;
    else if (arg === '--model') args.model = next, i++;
    else if (arg === '--max-budget-usd') args.maxBudgetUsd = next, i++;
    else if (arg === '--mode') args.mode = next, i++;
    else if (arg === '--delay-ms') args.delayMs = Number(next), i++;
    else if (arg === '--timeout-ms') args.timeoutMs = Number(next), i++;
    else if (arg === '--max-width') args.maxWidth = Number(next), i++;
    else if (arg === '--max-stages') args.maxStages = Number(next), i++;
    else if (arg === '--skip-verify') args.skipVerify = true;
    else if (arg === '--no-notes') args.includeNotes = false;
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/erdos-max-harness.js [options]

Options:
  --status open|proved|disproved|verifiable  Filter database state (default: open)
  --problem 1,3,1196                         Fetch exact problem numbers
  --tag "number theory"                      Filter by tag
  --formalized yes|no                        Filter by formalized.state
  --limit N                                  Number of problems to fetch (default: 10)
  --out-dir DIR                              Output directory (default: ${DEFAULT_OUT_DIR})
  --no-tex                                   Skip Fermat .tex export
  --attempt-limit N                          Run proof attempts on first N fetched problems (default: 0)
  --runner fermat-max|claude-xhigh            Attempt runner (default: fermat-max)
  --effort low|medium|high|xhigh|max          Claude CLI effort for claude-xhigh attempts (default: xhigh)
  --model sonnet|opus|...                    Claude CLI model (default: sonnet)
  --max-budget-usd N                         Per-attempt CLI budget guard (default: 1.00)
  --mode triage|solve                        Prompt style for attempts (default: triage)
  --max-width N                              Fermat max pipeline width (default: 2)
  --max-stages N                             Fermat max pipeline stages (default: 1)
  --skip-verify                              Skip Fermat verifier calls inside max pipeline
  --delay-ms N                               Polite delay between site fetches (default: 250)
  --no-notes                                 Prompt claude-xhigh with statement only
`);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Fermat research harness (https://github.com/dangxingyu/fermat)',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchText(new URL(res.headers.location, url).toString()));
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

function parseMetadata(yaml) {
  return yaml
    .split(/\n(?=- number:\s*)/g)
    .map(block => {
      const number = matchOne(block, /- number:\s*"([^"]+)"/);
      if (!number) return null;
      const statusBlock = matchOne(block, /\n  status:\n([\s\S]*?)(?=\n  \S|$)/);
      const formalizedBlock = matchOne(block, /\n  formalized:\n([\s\S]*?)(?=\n  \S|$)/);
      return {
        number,
        prize: matchOne(block, /\n  prize:\s*(?:"([^"]+)"|([^\n]+))/) || 'unknown',
        status: {
          state: matchOne(statusBlock || '', /state:\s*"([^"]+)"/) || 'unknown',
          lastUpdate: matchOne(statusBlock || '', /last_update:\s*"([^"]+)"/) || null,
        },
        formalized: {
          state: matchOne(formalizedBlock || '', /state:\s*"([^"]+)"/) || 'unknown',
          lastUpdate: matchOne(formalizedBlock || '', /last_update:\s*"([^"]+)"/) || null,
        },
        tags: parseInlineList(matchOne(block, /\n  tags:\s*\[([^\]]*)\]/) || ''),
      };
    })
    .filter(Boolean);
}

function matchOne(text, regex) {
  const match = String(text || '').match(regex);
  if (!match) return '';
  return (match[1] || match[2] || '').trim();
}

function parseInlineList(text) {
  return String(text || '')
    .split(',')
    .map(s => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function decodeHtml(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return named[entity] || _;
  });
}

function cleanHtml(html) {
  return decodeHtml(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n'))
    .trim();
}

function parseLatexPage(number, html) {
  const statementHtml = matchOne(html, /<div id="content"[^>]*>([\s\S]*?)<\/div>/i);
  const blocks = [...String(html).matchAll(/<div class="problem-additional-text"[^>]*>([\s\S]*?)<\/div>/gi)]
    .map(m => cleanHtml(m[1]))
    .filter(text => text && !/^Back to the problem$/i.test(text));
  const referencesIndex = blocks.findIndex(text => /^References\b/i.test(text));
  const notes = referencesIndex >= 0 ? blocks.slice(0, referencesIndex) : blocks;
  const references = referencesIndex >= 0 ? blocks.slice(referencesIndex).join('\n\n') : '';
  return {
    number: String(number),
    url: `${PROBLEM_BASE}/${number}`,
    latexUrl: `${PROBLEM_BASE}/latex/${number}`,
    statement: cleanHtml(statementHtml),
    notes: notes.join('\n\n'),
    references,
  };
}

function filterMetadata(items, args) {
  let selected = items;
  if (args.problems?.length) {
    const wanted = new Set(args.problems.map(String));
    selected = selected.filter(item => wanted.has(String(item.number)));
  } else {
    if (args.status) selected = selected.filter(item => item.status.state === args.status);
    if (args.tag) selected = selected.filter(item => item.tags.includes(args.tag));
    if (args.formalized) selected = selected.filter(item => item.formalized.state === args.formalized);
  }
  return selected.slice(0, args.limit);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeTexDocument(problems, args) {
  const body = problems.map(problem => {
    const comments = [
      `Source: ${problem.url}`,
      `Database status: ${problem.status.state}${problem.status.lastUpdate ? `, updated ${problem.status.lastUpdate}` : ''}`,
      `Tags: ${problem.tags.join(', ') || 'none'}`,
      problem.notes ? `Notes excerpt:\n${problem.notes.slice(0, 1800)}` : '',
    ].filter(Boolean).join('\n');
    return [
      `\\begin{conjecture}[Erd\\H{o}s Problem \\#${problem.number}]`,
      `\\label{erdos:${problem.number}}`,
      problem.statement || 'Statement unavailable.',
      '\\end{conjecture}',
      '% [PROVE IT: max]',
      latexCommentBlock(comments),
    ].join('\n');
  }).join('\n\n');

  return [
    '\\documentclass{article}',
    '\\usepackage{amsmath, amssymb, amsthm}',
    '\\newtheorem{conjecture}{Conjecture}',
    '\\title{Erd\\H{o}s Problems Max Pipeline Smoke Set}',
    '\\author{Fermat crawler}',
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    `% Generated from ${PROBLEM_BASE} and teorth/erdosproblems.`,
    `% Filter: status=${args.status || 'any'} limit=${args.limit}`,
    '',
    body,
    '',
    '\\end{document}',
    '',
  ].join('\n');
}

function makeSingleProblemTex(problem) {
  return makeTexDocument([problem], {
    status: problem.status?.state || 'unknown',
    limit: 1,
  });
}

function latexCommentBlock(text) {
  return String(text || '')
    .split('\n')
    .map(line => `% ${line}`)
    .join('\n');
}

function makeAttemptPrompt(problem, args) {
  const isTriage = args.mode !== 'solve';
  const notes = args.includeNotes && problem.notes
    ? `\nContext notes from erdosproblems.com:\n${problem.notes.slice(0, 6000)}\n`
    : '';
  return `We are running a Claude xhigh smoke experiment on an Erdős problem.

Source: ${problem.url}
Database status: ${problem.status.state}
Tags: ${problem.tags.join(', ') || 'none'}
Prize: ${problem.prize || 'unknown'}

Problem statement:
${problem.statement}
${notes}
Task:
${isTriage
  ? 'This is a timeboxed TRIAGE pass, not a full paper-length attempt. Spend the effort on deciding whether the problem has a plausible short attack, and stop once the main obstruction is clear.'
  : 'Try very hard to solve or disprove the problem, but be epistemically conservative.'}
Do not present a breakthrough as solved unless every nontrivial step is proved.
It is useful to return partial progress, reductions, candidate counterexamples, or a clear reason the attempt is blocked.
Keep the answer under 1200 words unless you have a genuinely complete proof.

Return this exact markdown shape:

## Outcome
One of: plausible_solution | plausible_disproof | partial_progress | blocked | known_solved_or_not_open

## Confidence
low | medium | high

## Main Attempt
Write the proof/disproof attempt or the strongest reduction you found.

## Gaps
List every unproved nontrivial claim.

## Next Lemmas
List concrete lemmas a Fermat max-effort proof should try next.
`;
}

function runClaude(prompt, args, outFile) {
  return new Promise((resolve, reject) => {
    const cliArgs = [
      '--print',
      '--effort', args.effort,
      '--model', args.model,
      '--max-budget-usd', String(args.maxBudgetUsd),
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      prompt,
    ];
    const child = spawn('claude', cliArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude attempt timed out after ${args.timeoutMs}ms`));
    }, args.timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      fs.writeFileSync(outFile, stdout);
      if (stderr) fs.writeFileSync(outFile.replace(/\.md$/, '.stderr.txt'), stderr);
      if (code !== 0) reject(new Error(`Claude exited with ${code}; wrote ${outFile}`));
      else resolve(stdout);
    });
  });
}

async function runFermatMax(problem, args, outDir) {
  const texContent = makeSingleProblemTex(problem);
  const texPath = path.join(outDir, `problem-${problem.number}-fermat-max.tex`);
  fs.writeFileSync(texPath, texContent);

  const outline = parseTheoryOutline(texContent);
  const target = outline.nodes.find(node => node.labels?.includes(`erdos:${problem.number}`));
  if (!target?.proveItMarker) {
    throw new Error(`Could not find Fermat max marker for Erdős problem #${problem.number}`);
  }

  const backend = new ClaudeCodeBackend();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, args.timeoutMs);

  const statusLog = [];
  const streamPath = path.join(outDir, 'attempts', `${problem.number}-fermat-max.stream.txt`);
  fs.writeFileSync(streamPath, '');
  const startedAt = new Date().toISOString();

  try {
    const result = await backend.prove(texContent, {
      ...target.proveItMarker,
      id: target.id,
      label: `erdos:${problem.number}`,
      lineNumber: target.proveItMarker.lineNumber,
      filePath: texPath,
      fullContent: texContent,
    }, {
      model: args.model,
      skipVerify: args.skipVerify,
      maxProofWidth: args.maxWidth,
      maxProofStages: args.maxStages,
      signal: controller.signal,
      onStatus: status => {
        statusLog.push({ at: new Date().toISOString(), ...status });
        console.log(`[fermat-max #${problem.number}] ${status.phase || status.status || 'status'} ${JSON.stringify(status)}`);
      },
      onStream: chunk => {
        fs.appendFileSync(streamPath, chunk);
      },
    });

    const summary = {
      problem: {
        number: problem.number,
        url: problem.url,
        status: problem.status,
        tags: problem.tags,
      },
      runner: 'fermat-max',
      startedAt,
      completedAt: new Date().toISOString(),
      options: {
        model: args.model,
        maxProofWidth: args.maxWidth,
        maxProofStages: args.maxStages,
        skipVerify: args.skipVerify,
      },
      statusLog,
      proof: result.proof || '',
      knowledge: result.knowledge || null,
      sketch: result.sketch || null,
      proofNotebook: result.proofNotebook || null,
      proofPipeline: result.proofPipeline || null,
      maxPipeline: result.maxPipeline || null,
      verdict: result.verdict || null,
    };

    const jsonPath = path.join(outDir, 'attempts', `${problem.number}-fermat-max.json`);
    const proofPath = path.join(outDir, 'attempts', `${problem.number}-fermat-max-proof.tex`);
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    fs.writeFileSync(proofPath, result.proof || '');
    console.log(`[erdos] Wrote ${jsonPath}`);
    console.log(`[erdos] Wrote ${proofPath}`);
    return summary;
  } catch (err) {
    const failedPath = path.join(outDir, 'attempts', `${problem.number}-fermat-max.failed.json`);
    fs.writeFileSync(failedPath, JSON.stringify({
      problem: { number: problem.number, url: problem.url, status: problem.status, tags: problem.tags },
      runner: 'fermat-max',
      startedAt,
      failedAt: new Date().toISOString(),
      error: err.message,
      code: err.code || err.fermatCode || null,
      statusLog,
    }, null, 2));
    console.log(`[erdos] Wrote ${failedPath}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const attemptsDir = path.join(outDir, 'attempts');
  ensureDir(outDir);
  ensureDir(attemptsDir);

  console.log(`[erdos] Fetching metadata: ${META_URL}`);
  const metadata = parseMetadata(await fetchText(META_URL));
  const selected = filterMetadata(metadata, args);
  console.log(`[erdos] Selected ${selected.length} problem(s)`);

  const problems = [];
  for (const meta of selected) {
    const url = `${PROBLEM_BASE}/latex/${meta.number}`;
    console.log(`[erdos] Fetching #${meta.number}: ${url}`);
    const html = await fetchText(url);
    problems.push({ ...meta, ...parseLatexPage(meta.number, html) });
    if (args.delayMs > 0) await sleep(args.delayMs);
  }

  const jsonPath = path.join(outDir, 'problems.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: { metadata: META_URL, website: PROBLEM_BASE },
    filter: {
      status: args.status,
      tag: args.tag || null,
      formalized: args.formalized || null,
      problems: args.problems || null,
      limit: args.limit,
    },
    problems,
  }, null, 2));
  console.log(`[erdos] Wrote ${jsonPath}`);

  if (args.tex) {
    const texPath = path.join(outDir, 'erdos-problems-max.tex');
    fs.writeFileSync(texPath, makeTexDocument(problems, args));
    console.log(`[erdos] Wrote ${texPath}`);
  }

  const attemptCount = Math.min(args.attemptLimit || 0, problems.length);
  for (let i = 0; i < attemptCount; i++) {
    const problem = problems[i];
    if (args.runner === 'fermat-max') {
      console.log(`[erdos] Running Fermat max pipeline for #${problem.number}`);
      await runFermatMax(problem, args, outDir);
    } else if (args.runner === 'claude-xhigh') {
      const outFile = path.join(attemptsDir, `${problem.number}-${args.effort}.md`);
      console.log(`[erdos] Running Claude ${args.effort} attempt for #${problem.number}; output ${outFile}`);
      await runClaude(makeAttemptPrompt(problem, args), args, outFile);
    } else {
      throw new Error(`Unknown runner: ${args.runner}`);
    }
    console.log(`\n[erdos] Finished #${problem.number}`);
  }
}

main().catch(err => {
  console.error(`[erdos] ${err.stack || err.message}`);
  process.exit(1);
});
