# Natural Language Proof Pipeline

Fermat's natural-language proving path is intended to be conservative about
mathematical knowledge. The prover should not treat a plausible missing lemma as
an already established fact. The pipeline is:

1. Assemble local document context: target theorem, dependency graph, known
   accepted proofs, preamble, and full source.
2. Load the project knowledge ledger from `.fermat/knowledge.md` when present.
3. Run `fermat-knowledge` to select usable facts, candidate obligations,
   research needs, and forbidden routes for the current target.
4. Run `fermat-sketch` to produce a machine-readable `<proof_plan>` with
   available facts, proof obligations, fact tiers, and use policies.
5. Run `fermat-prove` to write a proof that only cites licensed facts and proves
   candidate obligations before using them.
6. Run `fermat-verify` to audit the proof, including implicit nontrivial facts
   such as "standard concentration bound" or "compactness argument".

## Knowledge Tiers

- `T0_DOCUMENT_PROVED`: proved in the current document or accepted proof memory.
- `T1_SOURCE_BACKED`: sourced from a paper/book/note with conditions recorded.
- `T2_ALMOST_SURE`: very likely true, but not currently proved or sourced.
- `T3_LIKELY_PROVABLE`: plausible and useful, but proof still needs work.
- `T4_SPECULATIVE`: exploratory conjecture only.
- `N1_LIKELY_FALSE`: evidence suggests the statement is false.
- `X_REFUTED`: known false under the current assumptions.

## Use Policies

- `cite_directly`: may be used directly in the proof. Only valid for T0 and
  condition-checked T1 facts.
- `prove_inline`: must be proved in the current proof before use.
- `prove_as_sublemma`: should become a separate lemma or a clearly marked
  internal claim.
- `research_before_use`: needs source review before use.
- `do_not_use`: forbidden in the proof.

## Ledger Template

Create this file inside a proof project as `.fermat/knowledge.md`.

```markdown
# Fermat Knowledge Ledger

## Sources

### source-id
- Citation:
- File or URL:
- Reviewed:
- Scope:
- Reliability:
- Notes:

## T0 Document-Proved Facts

### fact-id
- Statement:
- Document label:
- Conditions:
- Use policy: cite_directly
- Last checked:

## T1 Source-Backed Facts

### fact-id
- Statement:
- Source:
- Location:
- Conditions:
- Use policy: cite_directly | research_before_use
- Confidence:
- Notes:

## T2 Almost-Sure Lemmas

### lemma-id
- Statement:
- Evidence:
- Needed for:
- Use policy: prove_inline | prove_as_sublemma
- Confidence:
- Proof idea:

## T3 Likely-Provable Lemmas

### lemma-id
- Statement:
- Evidence:
- Needed for:
- Use policy: prove_inline | prove_as_sublemma | research_before_use
- Confidence:
- Blocking issues:

## T4 Speculative Conjectures

### conjecture-id
- Statement:
- Motivation:
- Use policy: research_before_use
- Confidence:
- Risks:

## N1 Likely-False / X Refuted

### item-id
- Statement:
- Tier: N1_LIKELY_FALSE | X_REFUTED
- Evidence or counterexample:
- Use policy: do_not_use
- Notes:

## Failed Attempts

### attempt-id
- Target:
- Route tried:
- Failure mode:
- What not to repeat:
- Possible salvage:
```

## Update Discipline

The backend currently reads the ledger but does not write it. Skills may emit
`ledger_update_suggestions`; a future UI action should let the user accept,
edit, or reject those suggestions explicitly. This keeps mathematical
assumptions auditable instead of letting the LLM silently mutate the project
state.
