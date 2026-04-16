/**
 * Run all remaining eval tests:
 * - Sketch (with skill)
 * - All 5 without_skill baselines (no skill, just raw prompt)
 */
const fs = require('fs');
const path = require('path');
const { parseTheoryOutline } = require('./src/main/outline-parser');
const { ContextAssembler } = require('./src/main/context-assembler');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
  console.error('  node test-all-evals.js');
  process.exit(1);
}

const SAMPLE_TEX = `\\documentclass{article}
\\usepackage{amsmath, amssymb, amsthm}
\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{lemma}[theorem]{Lemma}
\\newtheorem{proposition}[theorem]{Proposition}
\\newtheorem{corollary}[theorem]{Corollary}
\\theoremstyle{definition}
\\newtheorem{definition}[theorem]{Definition}
\\title{Sample Theory Document}
\\author{Fermat}
\\begin{document}
\\maketitle
\\section{Foundations}
\\begin{definition}[Prime Number]
\\label{def:prime}
A natural number $p > 1$ is \\emph{prime} if its only positive divisors are $1$ and $p$.
\\end{definition}
\\begin{theorem}[Infinitude of Primes]
\\label{thm:inf-primes}
There are infinitely many prime numbers.
\\end{theorem}
\\begin{proof}
Suppose for contradiction that there are only finitely many primes $p_1, \\ldots, p_n$.
Consider $N = p_1 \\cdots p_n + 1$. Then $N > 1$ has a prime divisor $p$, but $p \\neq p_i$
for any $i$, a contradiction.
\\end{proof}
\\begin{lemma}[Division Lemma]
\\label{lem:division}
For any integers $a$ and $b > 0$, there exist unique integers $q$ and $r$
such that $a = bq + r$ and $0 \\leq r < b$.
\\end{lemma}
% [PROVE IT: Medium]
\\section{Main Results}
\\begin{theorem}[Fundamental Theorem of Arithmetic]
\\label{thm:fta}
Every integer $n > 1$ can be written uniquely as a product of prime numbers,
up to the order of factors. This relies on Lemma~\\ref{lem:division}
and the definition of primes (Definition~\\ref{def:prime}).
\\end{theorem}
% [PROVE IT: Hard]
\\begin{corollary}
\\label{cor:sqrt2}
$\\sqrt{2}$ is irrational. This follows from Theorem~\\ref{thm:fta}.
\\end{corollary}
% [PROVE IT: Medium]
\\end{document}`;

const GOOD_PROOF = fs.readFileSync('test-outputs/prove-hard-fta.tex', 'utf-8');
const BAD_PROOF = `\\begin{proof}
We prove by induction on $n$.
\\textbf{Base case:} $n = 2$ is prime, so it is its own prime factorization.
\\textbf{Inductive step:} Assume every integer $k$ with $2 \\leq k < n$ has a unique prime factorization. If $n$ is prime, we are done. If $n$ is composite, write $n = ab$ with $1 < a, b < n$. By induction, $a$ and $b$ have prime factorizations, so $n$ does too.
For uniqueness, suppose $n = p_1 \\cdots p_r = q_1 \\cdots q_s$. Since $p_1$ divides the right side, $p_1$ must divide some $q_j$. Since both are prime, $p_1 = q_j$. Cancel to get $p_2 \\cdots p_r = q_1 \\cdots \\hat{q}_j \\cdots q_s$ and apply induction.
\\end{proof}`;

async function callClaude(system, user) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: API_KEY });
  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: system || undefined,
    messages: [{ role: 'user', content: user }],
  });
  const duration = Date.now() - t0;
  const text = response.content[0]?.text || '';
  const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
  return { text, tokens, duration };
}

function loadSkill(name) {
  return fs.readFileSync(
    path.join(__dirname, `.claude/skills/${name}/SKILL.md`), 'utf-8'
  ).replace(/^---[\\s\\S]*?---\\n*/, '');
}

function getContext(targetName) {
  const outline = parseTheoryOutline(SAMPLE_TEX);
  const target = outline.nodes.find(n => n.name === targetName);
  const assembler = new ContextAssembler();
  const ctx = assembler.assembleForProof(outline, target);
  return assembler.formatAsPrompt(ctx);
}

const WS = path.join(__dirname, 'fermat-skills-workspace/iteration-1');

async function runAndSave(evalDir, variant, system, user) {
  const dir = path.join(WS, evalDir, variant, 'outputs');
  console.log(`  Running ${evalDir}/${variant}...`);
  const { text, tokens, duration } = await callClaude(system, user);
  fs.writeFileSync(path.join(dir, 'result.txt'), text);
  fs.writeFileSync(path.join(dir, '../timing.json'), JSON.stringify({
    total_tokens: tokens, duration_ms: duration, total_duration_seconds: duration / 1000,
  }));
  console.log(`  Done: ${tokens} tokens, ${(duration/1000).toFixed(1)}s`);
  return text;
}

async function main() {
  const ctxInfPrimes = getContext('Infinitude of Primes');
  const ctxFTA = getContext('Fundamental Theorem of Arithmetic');
  const proveSkill = loadSkill('fermat-prove');
  const verifySkill = loadSkill('fermat-verify');
  const sketchSkill = loadSkill('fermat-sketch');

  // ── Sketch (with_skill) ──
  console.log('=== Sketch FTA (with_skill) ===');
  await runAndSave('sketch-hard-fta', 'with_skill', sketchSkill, ctxFTA);

  // ── Baselines (without_skill) ──
  const baselineSystem = 'You are an expert mathematician writing LaTeX proofs. Be rigorous and precise.';

  console.log('\n=== Baselines (without_skill) ===');

  // 1. Prove Easy baseline
  console.log('--- Prove Easy baseline ---');
  await runAndSave('prove-easy-inf-primes', 'without_skill', baselineSystem,
    `Prove the following theorem in LaTeX. Output only \\begin{proof}...\\end{proof}.\n\nTheorem (Infinitude of Primes): There are infinitely many prime numbers.\n\nDifficulty: Easy. Be concise.`);

  // 2. Prove Hard baseline
  console.log('--- Prove Hard baseline ---');
  await runAndSave('prove-hard-fta', 'without_skill', baselineSystem,
    `Prove the following theorem in LaTeX. Output only \\begin{proof}...\\end{proof}.\n\nTheorem (Fundamental Theorem of Arithmetic): Every integer n > 1 can be written uniquely as a product of prime numbers, up to the order of factors.\n\nYou may use: Division Lemma (for integers a, b>0 there exist unique q,r with a=bq+r, 0<=r<b) and the definition of prime numbers.\n\nDifficulty: Hard. Be thorough.`);

  // 3. Verify good proof baseline
  console.log('--- Verify good proof baseline ---');
  await runAndSave('verify-good-fta', 'without_skill', baselineSystem,
    `Check the following proof of the Fundamental Theorem of Arithmetic for correctness. State whether it is correct (PASS), needs revision (NEEDS_REVISION), or is wrong (FAIL). List any issues.\n\nTheorem: Every integer n > 1 can be written uniquely as a product of primes.\n\nProof to check:\n${GOOD_PROOF}`);

  // 4. Verify bad proof baseline
  console.log('--- Verify bad proof baseline ---');
  await runAndSave('verify-bad-fta', 'without_skill', baselineSystem,
    `Check the following proof of the Fundamental Theorem of Arithmetic for correctness. State whether it is correct (PASS), needs revision (NEEDS_REVISION), or is wrong (FAIL). List any issues.\n\nTheorem: Every integer n > 1 can be written uniquely as a product of primes.\n\nProof to check:\n${BAD_PROOF}`);

  // 5. Sketch baseline
  console.log('--- Sketch baseline ---');
  await runAndSave('sketch-hard-fta', 'without_skill', baselineSystem,
    `Before writing a proof, outline a proof strategy for the Fundamental Theorem of Arithmetic: Every integer n > 1 can be written uniquely as a product of primes.\n\nIdentify the approach, prerequisites, key steps, and potential difficulties.\n\nAvailable tools: Division Lemma, definition of prime numbers.`);

  console.log('\n=== All evals complete ===');
}

main().catch(err => { console.error(err); process.exit(1); });
