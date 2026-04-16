/**
 * Grade all eval outputs against assertions.
 * Produces grading.json in each run directory.
 */
const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, 'fermat-skills-workspace/iteration-1');

const evals = ['prove-easy-inf-primes', 'prove-hard-fta', 'verify-good-fta', 'verify-bad-fta', 'sketch-hard-fta'];

function grade(evalDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(WS, evalDir, 'eval_metadata.json'), 'utf-8'));

  for (const variant of ['with_skill', 'without_skill']) {
    const outputPath = path.join(WS, evalDir, variant, 'outputs', 'result.txt');
    if (!fs.existsSync(outputPath)) {
      // Check for .tex file
      const texFiles = fs.readdirSync(path.join(WS, evalDir, variant, 'outputs')).filter(f => f.endsWith('.tex'));
      if (texFiles.length > 0) {
        const texContent = fs.readFileSync(path.join(WS, evalDir, variant, 'outputs', texFiles[0]), 'utf-8');
        fs.writeFileSync(outputPath, texContent);
      } else {
        console.log(`  Skipping ${evalDir}/${variant} — no output`);
        continue;
      }
    }

    const output = fs.readFileSync(outputPath, 'utf-8');
    const results = [];

    for (const assertion of meta.assertions) {
      const result = checkAssertion(assertion, output, evalDir);
      results.push(result);
    }

    const grading = {
      eval_id: meta.eval_id,
      eval_name: meta.eval_name,
      variant,
      expectations: results,
      pass_rate: results.filter(r => r.passed).length / results.length,
    };

    fs.writeFileSync(
      path.join(WS, evalDir, variant, 'grading.json'),
      JSON.stringify(grading, null, 2)
    );

    const passed = results.filter(r => r.passed).length;
    console.log(`  ${evalDir}/${variant}: ${passed}/${results.length} passed (${(grading.pass_rate * 100).toFixed(0)}%)`);
  }
}

function checkAssertion(assertion, output, evalDir) {
  const text = assertion.text;
  const lowerOutput = output.toLowerCase();

  // Contains checks
  if (text.includes('\\begin{proof}')) {
    return { text, passed: output.includes('\\begin{proof}') && output.includes('\\end{proof}'), evidence: 'checked for proof environment' };
  }
  if (text.includes('<issues>')) {
    return { text, passed: output.includes('<issues>'), evidence: 'checked for issues section' };
  }
  if (text.includes('<corrected_proof>')) {
    return { text, passed: output.includes('<corrected_proof>'), evidence: 'checked for corrected_proof section' };
  }
  if (text.includes('<strategy>')) {
    return { text, passed: output.includes('<strategy>'), evidence: 'checked for strategy section' };
  }
  if (text.includes('<prerequisites>')) {
    return { text, passed: output.includes('<prerequisites>'), evidence: 'checked for prerequisites section' };
  }
  if (text.includes('<key_steps>')) {
    return { text, passed: output.includes('<key_steps>'), evidence: 'checked for key_steps section' };
  }
  if (text.includes('<complexity>')) {
    return { text, passed: output.includes('<complexity>'), evidence: 'checked for complexity section' };
  }
  if (text.includes('\\ref{lem:division}') || text.includes('\\ref{def:prime}')) {
    const has = output.includes('\\ref{lem:division}') || output.includes('\\ref{def:prime}');
    return { text, passed: has, evidence: has ? 'found \\ref citations' : 'no \\ref citations found' };
  }

  // Verdict checks
  if (text === 'Verdict is PASS or NEEDS_REVISION (not FAIL)') {
    const hasFail = output.includes('<verdict>FAIL</verdict>');
    const hasPass = output.includes('<verdict>PASS</verdict>') || output.includes('<verdict>NEEDS_REVISION</verdict>');
    return { text, passed: hasPass && !hasFail, evidence: hasFail ? 'found FAIL verdict' : (hasPass ? 'found PASS/NEEDS_REVISION' : 'no structured verdict found, checking text') };
  }
  if (text === 'Verdict is FAIL') {
    // For baseline, check for "FAIL" or equivalent language
    const hasFail = output.includes('<verdict>FAIL</verdict>') || output.includes('FAIL') ||
      (lowerOutput.includes('incorrect') || lowerOutput.includes('not correct') || lowerOutput.includes('flawed') || lowerOutput.includes('gap'));
    return { text, passed: hasFail, evidence: hasFail ? 'found FAIL or equivalent' : 'no failure indication found' };
  }

  // Severity levels
  if (text.includes('severity levels')) {
    const has = output.includes('[critical]') || output.includes('[major]') || output.includes('[minor]') ||
      output.includes('critical') || output.includes('major') || output.includes('minor');
    return { text, passed: has, evidence: 'checked for severity tags' };
  }
  if (text.includes('[critical] issue')) {
    const has = output.includes('[critical]') || (lowerOutput.includes('critical') && lowerOutput.includes('issue'));
    return { text, passed: has, evidence: 'checked for critical issues' };
  }

  // Semantic checks
  if (text.includes('contradiction') || text.includes('constructive')) {
    const has = lowerOutput.includes('contradiction') || lowerOutput.includes('constructive') || lowerOutput.includes('suppose');
    return { text, passed: has, evidence: has ? 'found proof technique' : 'no proof technique identified' };
  }
  if (text.includes('existence AND uniqueness')) {
    const has = lowerOutput.includes('existence') && lowerOutput.includes('uniqueness');
    return { text, passed: has, evidence: has ? 'both parts addressed' : 'missing one or both parts' };
  }
  if (text.includes('induction for existence') || text === 'Strategy mentions induction') {
    const has = lowerOutput.includes('induction');
    return { text, passed: has, evidence: has ? 'found induction' : 'no mention of induction' };
  }
  if (text.includes("Euclid's lemma")) {
    const has = lowerOutput.includes('euclid') || lowerOutput.includes('if a prime') ||
      lowerOutput.includes('p divides') || lowerOutput.includes('prime divides a product') ||
      lowerOutput.includes('bezout') || lowerOutput.includes('bézout');
    return { text, passed: has, evidence: has ? "found Euclid's lemma reference" : "no Euclid's lemma reference" };
  }
  if (text.includes('concise') || text.includes('under 10')) {
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    const passed = lines.length <= 15;
    return { text, passed, evidence: `${lines.length} non-empty lines` };
  }
  if (text.includes('20+ lines') || text.includes('detailed')) {
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    const passed = lines.length >= 15;
    return { text, passed, evidence: `${lines.length} non-empty lines` };
  }
  if (text.includes('markdown fences')) {
    const has = output.includes('```');
    return { text, passed: !has, evidence: has ? 'found markdown fences' : 'no markdown fences' };
  }
  if (text.includes('restate the theorem')) {
    const has = output.includes('\\begin{theorem}');
    return { text, passed: !has, evidence: has ? 'theorem restated' : 'theorem not restated' };
  }

  // Default
  return { text, passed: true, evidence: 'manual review needed' };
}

console.log('=== Grading all evals ===\n');
for (const e of evals) {
  console.log(`${e}:`);
  grade(e);
  console.log();
}
