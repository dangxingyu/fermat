# Skill Benchmark: fermat-prove / fermat-sketch / fermat-verify

**Model**: claude-sonnet-4-6
**Date**: 2026-04-09T18:30:00Z
**Evals**: 5 tasks × 2 configurations (1 run each)

## Summary

| Metric | with_skill | without_skill | Delta |
|--------|-----------|---------------|-------|
| Pass Rate | **100% ± 0%** | 58.8% ± 38.6% | **+41.2pp** |
| Time | 25.7s ± 10.7s | 17.0s ± 7.8s | +8.7s |
| Tokens | 3,637 ± 1,014 | 1,278 ± 656 | +2,359 |

## Per-Eval Results

| Eval | with_skill | without_skill | Delta | Notes |
|------|-----------|---------------|-------|-------|
| prove-easy-inf-primes | 100% | 100% | ±0 | Easy proofs: skill adds no value over baseline |
| prove-hard-fta | 100% | 85.7% | +14.3pp | Skill catches missing `\ref` citation |
| verify-good-fta | 100% | 0% | **+100pp** | Baseline never uses structured `<verdict>/<issues>` format |
| verify-bad-fta | 100% | 75% | +25pp | Baseline catches obvious errors but lacks severity tagging |
| sketch-hard-fta | 100% | 33.3% | **+66.7pp** | Baseline doesn't produce `<strategy>/<key_steps>/<complexity>` |

## Key Findings

- **Verification gap is critical**: `verify-good-fta` scores 0% without the skill because the
  model does not structure its output in the `<verdict>PASS|FAIL|NEEDS_REVISION</verdict>` +
  `<issues>` format that Fermat's parser expects. The skill is load-bearing for the verify phase.

- **Sketch structure matters**: Without the skill, the model produces narrative text rather than
  the `<strategy>` / `<prerequisites>` / `<key_steps>` / `<complexity>` XML structure used by
  the prove phase. Skill = **+67pp** on sketch quality.

- **Easy proofs need no skill**: Both configurations score 100% on `prove-easy-inf-primes`.
  For trivial proofs the extra context / format guidance adds latency with no quality benefit.

- **Cost of the skill**: +2,359 tokens and +8.7s per task on average. Acceptable for a
  human-in-the-loop tool where correctness > throughput.

## How to Re-run

```bash
# Requires ANTHROPIC_API_KEY or Claude Code CLI
export ANTHROPIC_API_KEY=sk-ant-...
node test-all-evals.js      # re-generate outputs in fermat-skills-workspace/
node grade-evals.js         # re-grade and update grading.json files
```