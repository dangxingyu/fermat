/**
 * Test fermat-prove on Hard difficulty: Fundamental Theorem of Arithmetic
 * This target has dependencies: \ref{lem:division} and \ref{def:prime}
 */

const fs = require('fs');
const path = require('path');
const { parseTheoryOutline } = require('./src/main/outline-parser');
const { ContextAssembler } = require('./src/main/context-assembler');

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

async function main() {
  const outline = parseTheoryOutline(SAMPLE_TEX);

  // Find the FTA theorem
  const target = outline.nodes.find(n => n.name === 'Fundamental Theorem of Arithmetic');
  if (!target) {
    console.error('Target not found!');
    console.log('Nodes:', outline.nodes.map(n => `${n.type}: "${n.name}"`));
    process.exit(1);
  }

  console.log('Target:', target.type, target.name);
  console.log('Labels:', target.labels);
  console.log('Refs:', target.refs);
  console.log('Difficulty:', target.proveItMarker?.difficulty);

  const assembler = new ContextAssembler();
  const ctx = assembler.assembleForProof(outline, target);
  const contextPrompt = assembler.formatAsPrompt(ctx);

  console.log('\nDirect deps:', ctx.directDependencies.map(d => `${d.type}: ${d.name}`));
  console.log('Known proofs:', ctx.knownProofs.length);
  console.log('Context length:', contextPrompt.length, 'chars');

  // Load skill
  const skill = fs.readFileSync(
    path.join(__dirname, '.claude/skills/fermat-prove/SKILL.md'), 'utf-8'
  ).replace(/^---[\s\S]*?---\n*/, '');

  console.log('\n=== Calling Claude API (Hard proof) ===');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: skill,
    messages: [{ role: 'user', content: contextPrompt }],
  });

  const proof = response.content[0]?.text || '';
  console.log('\n=== Generated Proof (FTA, Hard) ===');
  console.log(proof);
  console.log('\n=== Usage ===');
  console.log('Input tokens:', response.usage?.input_tokens);
  console.log('Output tokens:', response.usage?.output_tokens);

  const outDir = path.join(__dirname, 'test-outputs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'prove-hard-fta.tex'), proof);
  console.log('Saved to test-outputs/prove-hard-fta.tex');
}

main().catch(err => { console.error(err); process.exit(1); });
