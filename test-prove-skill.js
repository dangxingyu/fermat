/**
 * Manual smoke test for the fermat-prove skill.
 *
 * Parses the sample document, assembles context for "Infinitude of Primes",
 * prepends the prove skill, and calls Claude API to generate a proof.
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
% [PROVE IT: Easy]

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
  console.log('=== Parsing document ===');
  const outline = parseTheoryOutline(SAMPLE_TEX);

  console.log(`Found ${outline.nodes.length} nodes, ${outline.edges.length} edges`);
  console.log('Preamble length:', outline.preamble.length, 'chars');
  console.log('Theorem styles:', JSON.stringify(outline.theoremStyles));

  // Find the "Infinitude of Primes" theorem
  const target = outline.nodes.find(n => n.name === 'Infinitude of Primes');
  if (!target) {
    console.error('Could not find target node!');
    console.log('Available nodes:', outline.nodes.map(n => `${n.type}: ${n.name}`));
    process.exit(1);
  }

  console.log('\n=== Target node ===');
  console.log('Type:', target.type);
  console.log('Name:', target.name);
  console.log('Labels:', target.labels);
  console.log('Statement:', target.statementTeX);
  console.log('Has proof:', target.hasProof);
  console.log('Prove marker:', target.proveItMarker);

  // Assemble context
  console.log('\n=== Assembling context ===');
  const assembler = new ContextAssembler();
  const ctx = assembler.assembleForProof(outline, target);
  const contextPrompt = assembler.formatAsPrompt(ctx);

  console.log('Context length:', contextPrompt.length, 'chars');
  console.log('Direct deps:', ctx.directDependencies.length);
  console.log('Transitive deps:', ctx.transitiveDependencies.length);

  // Load prove skill
  const skillPath = path.join(__dirname, '.claude/skills/fermat-prove/SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf-8');
  // Strip frontmatter for the prompt
  const skillBody = skill.replace(/^---[\s\S]*?---\n*/, '');

  // Build full prompt
  const systemPrompt = skillBody;
  const userPrompt = contextPrompt;

  console.log('\n=== Calling Claude API ===');
  console.log('System prompt length:', systemPrompt.length, 'chars');
  console.log('User prompt length:', userPrompt.length, 'chars');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const proof = response.content[0]?.text || '';
  console.log('\n=== Generated Proof ===');
  console.log(proof);
  console.log('\n=== Usage ===');
  console.log('Input tokens:', response.usage?.input_tokens);
  console.log('Output tokens:', response.usage?.output_tokens);

  // Save output
  const outDir = path.join(__dirname, 'test-outputs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'prove-easy-inf-primes.tex'), proof);
  fs.writeFileSync(path.join(outDir, 'context-prompt.txt'), `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`);
  console.log('\nSaved to test-outputs/');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
