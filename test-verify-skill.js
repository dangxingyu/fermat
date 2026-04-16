/**
 * Test fermat-verify on two cases:
 * 1. The correct FTA proof we generated (should PASS)
 * 2. A deliberately broken proof (should FAIL)
 */

const fs = require('fs');
const path = require('path');
const { parseTheoryOutline } = require('./src/main/outline-parser');
const { ContextAssembler } = require('./src/main/context-assembler');

const SAMPLE_TEX = `\\documentclass{article}
\\usepackage{amsmath, amssymb, amsthm}
\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{lemma}[theorem]{Lemma}
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
\\begin{lemma}[Division Lemma]
\\label{lem:division}
For any integers $a$ and $b > 0$, there exist unique integers $q$ and $r$
such that $a = bq + r$ and $0 \\leq r < b$.
\\end{lemma}
\\section{Main Results}
\\begin{theorem}[Fundamental Theorem of Arithmetic]
\\label{thm:fta}
Every integer $n > 1$ can be written uniquely as a product of prime numbers,
up to the order of factors. This relies on Lemma~\\ref{lem:division}
and the definition of primes (Definition~\\ref{def:prime}).
\\end{theorem}
% [PROVE IT: Hard]
\\end{document}`;

const GOOD_PROOF = fs.readFileSync(
  path.join(__dirname, 'test-outputs/prove-hard-fta.tex'), 'utf-8'
);

const BAD_PROOF = `\\begin{proof}
We prove by induction on $n$.

\\textbf{Base case:} $n = 2$ is prime, so it is its own prime factorization.

\\textbf{Inductive step:} Assume every integer $k$ with $2 \\leq k < n$ has a unique prime factorization. If $n$ is prime, we are done. If $n$ is composite, write $n = ab$ with $1 < a, b < n$. By induction, $a$ and $b$ have prime factorizations, so $n$ does too.

For uniqueness, suppose $n = p_1 \\cdots p_r = q_1 \\cdots q_s$. Since $p_1$ divides the right side, $p_1$ must divide some $q_j$. Since both are prime, $p_1 = q_j$. Cancel to get $p_2 \\cdots p_r = q_1 \\cdots \\hat{q}_j \\cdots q_s$ and apply induction.
\\end{proof}`;

async function testVerify(label, proofText) {
  const outline = parseTheoryOutline(SAMPLE_TEX);
  const target = outline.nodes.find(n => n.name === 'Fundamental Theorem of Arithmetic');

  const assembler = new ContextAssembler();
  const ctx = assembler.assembleForProof(outline, target);
  const contextPrompt = assembler.formatAsPrompt(ctx);

  const skill = fs.readFileSync(
    path.join(__dirname, '.claude/skills/fermat-verify/SKILL.md'), 'utf-8'
  ).replace(/^---[\s\S]*?---\n*/, '');

  const fullPrompt = `${contextPrompt}\n\n<proof_to_verify>\n${proofText}\n</proof_to_verify>`;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log(`${'='.repeat(60)}`);

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: skill,
    messages: [{ role: 'user', content: fullPrompt }],
  });

  const result = response.content[0]?.text || '';
  console.log(result);
  console.log(`\n[Tokens: ${response.usage?.input_tokens} in, ${response.usage?.output_tokens} out]`);

  const outDir = path.join(__dirname, 'test-outputs');
  fs.writeFileSync(path.join(outDir, `verify-${label.replace(/\s+/g, '-').toLowerCase()}.txt`), result);
}

async function main() {
  await testVerify('Good FTA proof (expect PASS)', GOOD_PROOF);
  await testVerify('Bad FTA proof (expect FAIL or NEEDS_REVISION)', BAD_PROOF);
}

main().catch(err => { console.error(err); process.exit(1); });
