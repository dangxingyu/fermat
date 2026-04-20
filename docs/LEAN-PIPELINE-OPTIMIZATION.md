# Fermat — Lean Pipeline Architecture Audit & Optimization Design

**Date:** 2026-04-20 (updated from 2026-04-19)
**Author:** Claude (reading audit, no code changes)
**Scope:** `lean-workspace/`, `src/main/lean-runner.js`, `src/main/claude-code-backend.js` (all of `_leanSketchFillVerify` + every prompt builder), `.claude/skills/fermat-{sketch,prove,verify}/SKILL.md`, `src/main/context-assembler.js`

---

## 0. Executive summary

Fermat's Lean integration today is a **working but shallow** sketch→fill→sorrify pipeline:

- It calls `lean <file>` as a **one-shot batch compile**. Every verification costs a full elaboration, even for a 3-line change.
- Prompts are **zero-shot, no examples, no Lean idiom priming**. The system prompt is a single sentence.
- Each sorry fill passes **±5 lines of surrounding text + a 800-char slice of `contextPrompt`** to the model. There is no goal-state extraction, no relevant-lemma retrieval, no dependency awareness.
- The retry loop is **N identical diagnose calls with the raw error text** — the 3rd attempt sees the same signal the 1st did, just more times.
- The workspace uses **mathlib pinned at v4.29.0** with no update mechanism, no cache of previously-verified theorems, and no partial-file workspace (every fill compiles the full theorem from scratch against mathlib, which is slow).

Against SOTA (Numina-Lean-Agent, Hilbert, Mechanic), Fermat's single biggest gap is **not using the Lean language server**. Most of the other wins (semantic retrieval, goal extraction, minimal-reproducer sorrification, parallel attempts) are either impossible or crude without LSP.

This document enumerates what's concretely missing, contrasts it with the three named systems, and proposes a roadmap ordered by impact/effort. **Two quick wins** (better prompts + goal-state extraction via `set_option pp.all` or `#check_failure` probes) recover a large fraction of Hilbert/Numina's advantage without infrastructure changes. **The medium-effort win** is switching from batch compile to an LSP-based `Lean.Server` client, which unlocks real goal state, true parallelism, and fast incremental re-check. **The large bet** is a Mechanic-style minimal-context sorrifier with semantic retrieval from mathlib.

---

## 1. Workspace architecture

### 1.1 Current state

Layout (`lean-workspace/`):

```
lean-workspace/
├── lakefile.toml                (name=fermat-lean, deps: mathlib @ v4.29.0)
├── lean-toolchain               (leanprover/lean4:v4.29.0)
├── lake-manifest.json           (mathlib rev 8a17838…, 9 transitive deps)
├── FermatLean.lean              (import FermatLean.Basic)
├── FermatLean/Basic.lean        (def hello := "world")
└── .lake/packages/mathlib/…     (.olean cache, gitignored)
```

Verification modes ([`lean-runner.js:155`](src/main/lean-runner.js:155)):
- **Core-only** — writes `/tmp/fermat-lean/verify_<ts>.lean`, runs `lean <file>`. No mathlib. ~1–3s.
- **Mathlib** — writes `lean-workspace/_FermatVerify_<ts>_<rand>.lean`, runs `lake env lean <file>` with `cwd=workspacePath`. Resolves `import Mathlib` from the pre-built olean cache. ~5–15s cold, ~3–8s warm.

Mathlib readiness is probed by walking `.lake/packages/mathlib/` for at least one `.olean` file ([`lean-runner.js:348`](src/main/lean-runner.js:348) — the B-07 fix).

### 1.2 Findings

**W-1 · Mathlib version is frozen with no update mechanism.**
`lakefile.toml` pins `rev = "v4.29.0"` and the toolchain pins `v4.29.0`. There's no UI affordance or CLI recipe documented for updating. When mathlib lands a useful tactic or lemma, users either edit the lakefile by hand and re-download ~10 GB of cache, or give up. Fermat's value prop hinges on mathlib breadth — this needs first-class support.

**W-2 · No cache of previously-verified theorems.**
Every compile starts from nothing. A session that proves 20 theorems re-elaborates each on every edit. For a heavy user this is 10s × dozens of iterations = minutes of compile tax. Mathlib itself caches via olean, but Fermat's *generated* theorems are never promoted into a persistent module — they live in one-shot temp files that are deleted on close ([`lean-runner.js:274`](src/main/lean-runner.js:274)).

**W-3 · Temp files are per-call; each fill recompiles the full theorem + all imports.**
The sorrifier loop (`_leanSketchFillVerify`, [line 379–449](src/main/claude-code-backend.js:379)) writes the ENTIRE sketch to disk for every sorry fill. If a theorem has 5 sorries, that's 5 full `import Mathlib` compilations per successful pass, more if retries fire. Each one re-elaborates the same unchanged prelude. This is the dominant latency cost.

**W-4 · Multi-import / multi-project support is absent.**
A real mathematician's document references prior theorems across files. Fermat's temp-file model can't express "this theorem depends on the three theorems I just accepted." The only workaround is that accepted theorems come back as LaTeX and are not re-proved in Lean — the Lean side has no memory.

**W-5 · Zero namespacing in temp files.**
All temp files are root-level `.lean` modules. When two concurrent verifications happen in mathlib mode, both write into `lean-workspace/`, each becomes a different top-level module name (`_FermatVerify_<ts>_<rand>`), and lake's discovery layer treats them as siblings of `FermatLean`. This is currently safe (they don't import each other) but fragile: if any temp file has a module-level side effect like `initialize`, the shared workspace state could cross-contaminate.

**W-6 · Cleanup relies on `proc.close`.**
If the Electron process dies mid-verify (crash, SIGKILL, laptop lid close), temp files are orphaned. Acceptable but worth a one-liner startup sweep.

### 1.3 Recommendations

| ID | Fix | Effort | Impact |
|----|-----|--------|--------|
| W-1 | Add a **"Update Mathlib"** action in Settings → Lean → `lake update && lake exe cache get`. Show download progress. Commit the new lakefile rev. | M | Unblocks users after any mathlib release |
| W-2 | Introduce `lean-workspace/UserTheorems/` — every user-accepted theorem that verified gets appended as a named `theorem …` in a `.lean` file, rebuilt with `lake build` on session end. Subsequent sessions `import UserTheorems` and get all prior work as available lemmas. | M | Compounding value over time |
| W-3 | **The big one.** Switch the Fermat workspace to a **long-lived server** model (see §3.3). Eliminates per-call elaboration of the unchanged prelude. | L | 3–10× speedup for everything downstream |
| W-4 | Extend the "accepted theorem" context feed: when the user has N accepted theorems, generate Lean skeletons for each and include them in the `FermatLean/Accepted.lean` module; `_leanSketchFillVerify` prepends `import FermatLean.Accepted`. | M | Unlocks multi-theorem proofs |
| W-5 | Put each verify into `lean-workspace/_verify/<uuid>/Target.lean` with `module := "Target"` and a unique subfolder. Namespaces the transient module and makes cleanup a single `rm -rf` of the subdir. | S | Hygiene / future-proofing |
| W-6 | On app start, `fs.rmSync(workspacePath + '/_FermatVerify_*', { recursive: true, force: true })` and same for `/tmp/fermat-lean/`. | XS | Trivial, worth doing |

---

## 2. Pipeline quality (prompts, retries, context)

### 2.1 Current state

**Top-level pipeline** ([`_leanSketchFillVerify`, l.266–475](src/main/claude-code-backend.js:266)):

```
Phase 1 — Sketch                 (≤3 attempts)
  ├─ _buildSketchPrompt  →  Claude  →  _extractLeanBlock
  └─ leanRunner.verify  →  errors?  →  retry w/ _buildSketchPrompt(…, attempt=n)

⏸  Statement Review  (user confirms / edits / cancels)

Phase 2 — Fill (per sorry, in-order)
  ├─ _parseSorries  →  [{ line, col, surroundingCode, expectedType }]
  └─ for each sorry:
       ├─ attempt 1:  _buildFillPrompt  →  verify
       └─ attempts 2..N:  _buildDiagnosePrompt(errors)  →  verify

Phase 3 — Final sweep
  └─ leanRunner.verify(currentCode)  →  record sorryStatuses, emit lean-{verified,partial,failed}
```

**System prompt** for every LLM call ([l.270](src/main/claude-code-backend.js:270)):

> `"You are a Lean 4 proof assistant. Output only valid Lean 4 code in a ```lean4 block."`

That's the entire priming. No mention of mathlib, tactic idioms, common pitfalls, Lean 4 vs Lean 3 syntax, preferred lemma lookup mechanism.

**Sketch prompt** (`_buildSketchPrompt`, [l.529](src/main/claude-code-backend.js:529)):
- Attempt 1: the 5 rules, `contextPrompt`, informal proof.
- Attempt 2–3: "Fix the STRUCTURE only" + previous sketch + errors.

**Fill prompt** (`_buildFillPrompt`, [l.583](src/main/claude-code-backend.js:583)):
- Full current code, ±5 line window around the sorry, the optional `expectedType` (only extracted if Claude happened to write `show T; sorry`), informal proof, and `contextPrompt.slice(0, 800)` — the first ~200 tokens of the LaTeX document context, truncated mid-sentence.

**Diagnose prompt** (`_buildDiagnosePrompt`, [l.609](src/main/claude-code-backend.js:609)):
- Current code, line-numbered error list, ±5 line window, `contextPrompt.slice(0, 600)`.

**Sorry parser** (`_parseSorries`, [l.565](src/main/claude-code-backend.js:565)):
- Regex: `/\bsorry\b/` per line.
- Expected type extracted only from `show T; sorry` or `(sorry : T)`.
- `surroundingCode` = 8 lines (−5, +3).

**Theorem statement parser** (`_parseTheoremStatement`, [l.635](src/main/claude-code-backend.js:635)):
- Searches for first `:=\s*(by\b|\{)` — works for `:= by` and `:= {` term-mode. Misses term-mode proofs without braces (e.g. `:= fun h => …`), `where` clauses ([B-14 in audit](docs/SOFTWARE-AUDIT.md)), and custom tactic blocks.

### 2.2 Findings

**P-1 · The system prompt is load-bearing but nearly empty.**
Lean 4 vs Lean 3 confusion alone accounts for a huge fraction of model errors (`funext`, `rintro`, `show` semantics, omega vs linarith, `Ne.symm` / `Ne.symm_iff`). A 200-word system prompt enumerating key Lean 4 conventions + the mathlib search strategy (`exact?`, `apply?`, `rw?`, `loogle`, `Mathlib.Tactic.Find`) would measurably improve first-try success.

**P-2 · Zero few-shot examples.**
Sketch-style proofs are stylistically load-bearing. A single worked example — natural proof in → Lean sketch with `sorry`s out, and the filled version — would cut structural errors dramatically. Cost is a fixed ~800 tokens per call; benefit empirically large.

**P-3 · Goal state is never extracted.**
Fermat relies on Claude emitting `show T; sorry` voluntarily and then parses `T` as the expected type. This is:
- Optional on the model's part (no guarantee the annotation appears).
- A LaTeX-like stringification, not the Lean-elaborated type (`Nat → Prop` vs what Lean would actually show after `intro n h`).
- Missing hypothesis context — Lean's goal view shows `h₁ : …`, `h₂ : …`, `⊢ …`. We show none of that.

A proper fix: after the sketch verifies, run a second pass that replaces each `sorry` with `by show ?_; admit_with_goal_dump` (or similar instrumentation) and extracts the real goal from lean output. Or use LSP `$/lean/plainGoal` at the sorry position.

**P-4 · Retry strategy is monotone.**
Attempts 2–N all use `_buildDiagnosePrompt` with the same error text. There's no **strategy diversification**:
- No "try a different tactic family" prompt
- No "simplify the statement first" prompt
- No parallel attempts with temperature > 0
- No `best_of_n` sampling
- No tree search

Effectively the model gets 3 shots at the same bat with the same pitch.

**P-5 · `contextPrompt` truncation is arbitrary.**
The fill prompt takes the first 800 chars of contextPrompt ([l.601](src/main/claude-code-backend.js:601)), the diagnose prompt the first 600. The LaTeX context is formatted by [`ContextAssembler`](src/main/context-assembler.js) with full-document sections — truncating by character count slices off whichever structured section happens to come last. There's no notion of "include relevant dependencies first, then truncate the chaff."

**P-6 · Sorry context is line-centric, not semantic.**
±5 lines of Lean text around a sorry tells the model about nearby syntax but not about:
- The surrounding `theorem` declaration (name, parameters, hypotheses)
- The enclosing tactic block's intros
- Local lemmas proved earlier in the same file
- Which mathlib lemmas name-pattern-match the goal

Better: `enclosingDeclaration + localHypotheses + expectedType + candidateLemmas`. All recoverable from LSP.

**P-7 · Sorry "progress" check is fragile.**
[l.381, l.425](src/main/claude-code-backend.js:381) use `(code.match(/\bsorry\b/g) || []).length` to track progress. Matches inside comments or string literals (e.g. `-- TODO: sorry case`) inflate the count, so a successful fill can appear as "no progress" and trigger a spurious retry, or a fill that introduces a new sorry in a comment can appear successful. Low-frequency but real.

**P-8 · Statement parser misses real Lean 4.**
`_parseTheoremStatement` regex `:=\s*(by\b|\{)` doesn't catch:
- `theorem foo : T := expr` (term-mode, no `by`, no `{`)
- `theorem foo : T where …` (structure-field proofs — Lean 4 uses `where` for instance bodies)
- `instance : C X where …`
- Definitions with `match … with` bodies that appear before the `:=`

The fallback (first 5 non-import lines) is heuristic noise.

**P-9 · No caching of identical fills across retries.**
Each retry calls `leanRunner.verify` on essentially the same code (one changed span). We pay full elaboration time each pass.

**P-10 · No cross-sorry ordering heuristic.**
Sorries are filled in source order. If sorry #3 is "the easy one" and #1 is "the hard one," Claude grinds on #1 first, burning retries. A harder-but-sometimes-worth-it strategy: fill the easiest (shortest expected type, fewest hypotheses) first; the resulting `have` names can then inform harder sorries.

### 2.3 Recommendations

| ID | Fix | Effort | Impact |
|----|-----|--------|--------|
| P-1 | Rewrite the LEAN_SYS system prompt. ~200 words covering: Lean 4 dialect cues, mathlib namespace conventions, `exact?`/`apply?`/`simp`/`omega`/`linarith` decision tree, formatting requirements. Same string for sketch/fill/diagnose. | XS | High |
| P-2 | Add 1–2 curated few-shot examples per phase (sketch, fill, diagnose) — cached, baked into the prompt builder. Use simple mathlib results (e.g. `∀ n : ℕ, n + 0 = n`, `∀ n m : ℕ, n + m = m + n`). | S | High |
| P-3 | After sketch verifies, **re-run with `set_option pp.all true` + one `#check` per sorry** to dump goal state. Parse `⊢ …` blocks into `{hypotheses, goal}`. Feed into fill prompts. No LSP required. | S | Very high |
| P-4 | **Diversify retries:** attempt 2 uses a "try a different tactic" system message, attempt 3 uses "decompose the goal into sub-`have` first." Add an optional `temperature: 0.7` + 2-sample parallel racing on attempt 2. | S | Medium |
| P-5 | Structured `contextPrompt` instead of char-slice. Let the caller pass `{ target, dependencies[], priorProofs[], docText }`. Include dependencies always, truncate `docText` last. | S | Medium |
| P-6 | After P-3 lands, sorry context becomes `{ enclosingDecl, localHyps, goal, candidateLemmas }`. `candidateLemmas` via `exact?` dry-run (see §3). | M | High |
| P-7 | Use an AST-aware sorry detector: split code into comment/string/code regions (simple state machine, ~30 LOC) and only match `\bsorry\b` in code regions. | XS | Low |
| P-8 | Replace regex with a tiny Lean 4 statement extractor: find declaration keyword (`theorem`/`lemma`/`def`/`instance`), balance-count braces/parens to locate the `:=` that's at depth 0. | XS | Low |
| P-9 | Memoize `verify(source)` with a content hash key. Skip re-compile if we've seen the exact source in this session. | XS | Medium (useful during diagnose cycles) |
| P-10 | Heuristic sort: shorter `expectedType` + fewer occurrences of `:= sorry` first. | XS | Low-medium |

---

## 3. Lean runner capabilities

### 3.1 Current state

`LeanRunner.verify()` is a **batch, one-shot, stdout-parsing** model:

1. Write source to disk.
2. `spawn('lean', [file])` (or `spawn('lake', ['env', 'lean', file])` in mathlib mode).
3. Collect stdout/stderr into lines.
4. Regex-parse each line against `^(.+?):(\d+):(\d+): (error|warning|info): (.+)$` ([l.29](src/main/lean-runner.js:29)).
5. Success = exit 0 + no error-severity lines.

All information about the proof flows through this regex. Goal state, expected types, hypothesis contexts, suggested tactics — none of it is available.

There is a 120 s timeout ([l.51, l.231](src/main/lean-runner.js:51)), a unique temp file per mathlib call ([l.197](src/main/lean-runner.js:197)), and abort-signal wiring ([l.299](src/main/lean-runner.js:299)).

### 3.2 Findings

**R-1 · No Lean language server.**
Lean 4 ships with `lean --server` (LSP over JSON-RPC on stdio), and there are two high-quality JS bindings: [`@leanprover/infoview`](https://github.com/leanprover/vscode-lean4) and [`repl`](https://github.com/leanprover-community/repl). The language server exposes:
- `$/lean/plainGoal` — goal state at a position
- `$/lean/plainTermGoal` — term-mode goal
- `textDocument/codeAction` — tactic suggestions (`exact?`, `apply?`, `rfl`, `omega` fixes)
- `textDocument/completion` — name-completion for partial identifiers
- Real-time elaboration — open once, edit incrementally, no per-call startup cost

Not using this is Fermat's single largest capability gap.

**R-2 · No way to probe a specific position.**
Want to know "what's the goal at line 42?" Currently: can't ask. The only signal is "did the whole file compile." Hilbert, Numina, LeanDojo, etc. all depend fundamentally on position-indexed goal state.

**R-3 · No tactic-suggestion loop.**
`exact?` and `apply?` are mathlib tactics that search for a lemma matching the current goal and emit "try this: exact foo bar". With LSP we'd invoke them programmatically and funnel suggestions to Claude. Without LSP we'd have to hack it by inserting `exact?` into the source and grepping the error output for the "Try this:" prefix — possible but brittle.

**R-4 · No incremental re-check.**
Every edit triggers a full re-elaboration. In mathlib mode this is 3–8s of hot-cache compile per verify, dominating the pipeline. With LSP the server keeps the elaborated prelude hot and re-checks only the changed spans.

**R-5 · No REPL.**
[`leanprover-community/repl`](https://github.com/leanprover-community/repl) is a tiny Lean binary that accepts `{ "cmd": "example : 1 + 1 = 2 := by rfl" }` over stdin and returns `{ "goals": […], "messages": […], "env": n }`. It's lighter than LSP, stateful (you can build up an environment), and widely used by research pipelines (including Numina, LeanDojo, etc.). For Fermat's use-case it's arguably a better fit than full LSP.

**R-6 · Concurrency is safe but slow.**
Unique temp filenames (fixed by B-02) make concurrent `verify()` calls safe. But each one still spawns a fresh `lean` process that has to load the full mathlib prelude olean graph — O(100k) olean files resolved, O(GBs) of mmap. Cold start alone is seconds.

**R-7 · Parsing is severity-only.**
The parser throws away location nesting, error kind (type mismatch vs unsolved goals vs syntax error), and any structured info — all collapsed to `{ file, line, col, severity, message }`. LSP emits `Diagnostic` objects with `range`, `source`, `code`, `relatedInformation`. Could route all of that into a richer `LeanError` shape.

### 3.3 Recommendations

| ID | Fix | Effort | Impact |
|----|-----|--------|--------|
| R-1 | **Replace one-shot compile with `repl`** ([leanprover-community/repl](https://github.com/leanprover-community/repl)). It's distributed as a Lean executable, can be added as a lakefile dependency, and exposes exactly the goal/message/env info we need over line-delimited JSON-RPC. Keep the current batch path as fallback for when repl isn't available. | **M** | **Very high** |
| R-2 | Expose `LeanRunner.goalAt(source, line, col)` → `{ hypotheses, goal }`. Implement via repl — the REPL's response to `sorry` includes the unsolved-goal message. | M | Very high |
| R-3 | Add `LeanRunner.suggestTactics(source, line, col)` → `string[]`. Implement by temporarily replacing the tactic with `exact?` or `apply?`, reading the "Try this:" output, and restoring. | S-M | High (for fill & diagnose phases) |
| R-4 | Use repl's `env` pointer — send the prelude once per session, then each verify replays only the specific theorem against that env. 5–20× speedup on warm verifies. | M (comes with R-1) | Very high |
| R-5 | Alternatively, start a long-lived `lean --server` and speak LSP directly. Heavier lift (20 methods, state tracking), but gets completion + code actions for free. Pick this over REPL if we also want in-editor LSP for the Lean side-panel. | L | Very high |
| R-6 | After R-1 lands: pool of N repl workers, each with mathlib prelude pre-loaded, assigned round-robin. Eliminates cold-start per verify. | S (post R-1) | High |
| R-7 | Extend `LeanError` to carry `kind` (type-mismatch / unsolved / syntax / name-not-found) inferred from message prefix, and `relatedLocations[]` for `at definition` refs. Enables smarter diagnose prompts ("the error is a name-not-found — try `exact?`"). | S | Medium |

---

## 3b. Prompt Engineering Review (added 2026-04-20)

This section analyses the full prompt stack — `LEAN_SYS`, the three prompt builders, and the three skill SKILL.md files — as a cohesive engineering unit.

### 3b.1 The skill files are LaTeX-centric; the Lean path is zero-shot

The three skills (`fermat-sketch`, `fermat-prove`, `fermat-verify`) are sophisticated, detailed documents covering LaTeX proof strategy, theory-map reading, dependency hygiene, and LaTeX self-checking. They are entirely unaware that a Lean formalization phase exists.

When `_leanSketchFillVerify` runs, none of these skills are loaded. The system prompt shrinks to one sentence (`LEAN_SYS`, [l.270](src/main/claude-code-backend.js:270)). Everything that makes the LaTeX phase high-quality — the rich SKILL.md priming, the theory-map semantics, the "check prerequisites" instructions — is absent from the Lean phase. The Lean phase is a naked zero-shot invocation.

**Consequence:** A proof that passed `fermat-prove` with a nuanced multi-step structure gets handed to the Lean sketch builder with no guidance about the structure that was just produced, no instruction about the proof technique that succeeded, and no Lean-specific guidance.

**Fix:** Create a `fermat-lean-sketch` SKILL.md analogous to `fermat-sketch` but targeting Lean 4. It should:
- Explain the sketch→fill→sorrify structure from a Lean perspective
- List the tactic families available in Mathlib (see §3b.3)
- Specify how to annotate sorries with `show T; sorry`
- Include 1–2 concrete examples of a natural proof → Lean skeleton

### 3b.2 Lean 3 vs Lean 4 confusion patterns

Claude was trained on substantial Lean 3 data (Mathlib3, older tutorials). These Lean 3 patterns appear in generated code and cause `lean` errors that consume retry budget:

| Lean 3 (wrong) | Lean 4 (correct) | Error seen |
|---|---|---|
| `begin ... end` | `by ...` | `unexpected token` |
| `nat.prime` | `Nat.Prime` | `unknown identifier` |
| `h.1` / `h.2` for `And` | `h.left` / `h.right` | `type mismatch` |
| `ring'` | `ring` | `unknown tactic` |
| `funext h,` (with comma) | `funext h` or `funext (h)` | `syntax error` |
| `cases h with \| inl h => ... \| inr h => ...` (but wrong pipe) | `rcases h with h \| h` | `syntax error` |
| `exact ⟨h₁, h₂⟩.1` | `exact (And.intro h₁ h₂).left` | confusing elaboration error |
| `#check` inside tactic block | `#check` is top-level only | `unexpected term` |

None of these patterns are mentioned in any current prompt. A 10-line "Lean 3 pitfalls to avoid" section in `LEAN_SYS` would eliminate a meaningful fraction of first-attempt failures.

### 3b.3 Missing tactic hierarchy guidance

Lean 4 with Mathlib has a well-known tactic decision tree. For a given goal shape, there is a "try-first" tactic that succeeds most of the time. Claude is not told this:

| Goal type | Try first | Then |
|-----------|-----------|------|
| Linear arithmetic over `ℤ`/`ℕ` | `omega` | `linarith` |
| Ring/field identities | `ring` | `field_simp; ring` |
| Decidable numerical facts | `norm_num` | `decide` |
| Propositional tautology | `tauto` | `aesop` |
| Existential with explicit witness | `exact ⟨w, h⟩` | `refine ⟨?_, ?_⟩` |
| Membership in finite set | `simp [Finset.mem_insert, ...]` | `decide` |
| Structural induction | `induction n with` | `Nat.rec` term-mode |
| Bounded cases | `fin_cases` | `interval_cases` |

Including this table (or a briefer version) in `LEAN_SYS` would give Claude a lookup mechanism, reducing the "try `simp` on everything" failure pattern.

### 3b.4 The sketch→fill disconnect

The sketch phase produces code like:
```lean
theorem inf_primes : ∀ n : ℕ, ∃ p > n, Nat.Prime p := by
  intro n
  show ∃ p > n, Nat.Prime p; sorry
```

The fill phase receives `_buildFillPrompt` with:
- `currentCode` — the full sketch ✓
- `sorry.surroundingCode` — ±5 lines around the sorry ✓
- `sorry.expectedType` — `∃ p > n, Nat.Prime p` (if annotated) ✓ / null (if not) ✗
- `naturalProof` — the LaTeX proof from `results.proof` ✓
- `contextPrompt.slice(0, 800)` — the first 800 chars of LaTeX XML ✗✗✗

The `contextPrompt.slice(0, 800)` is the most damaging item. The context built by `ContextAssembler.formatAsPrompt()` starts with `<preamble>` (LaTeX packages) — so 800 chars covers the `\documentclass`, a few `\usepackage` lines, and nothing else. The theorem statement, theory map, and all direct dependencies are absent from every fill prompt. This was presumably a token-budget precaution that predates current 200k-token context windows. It should be removed or replaced with a lean-relevant excerpt.

The `naturalProof` (LaTeX proof text) is included in full. This is mathematically valuable guidance but notionally foreign: "by Euclid's lemma" doesn't help Claude write `Nat.Prime.dvd_mul`. A **Lean-reformulation step** — one additional `_callLlm` before the sketch that asks Claude to restate the theorem and key lemmas in Lean terms — would convert the LaTeX mathematical context into directly actionable Lean guidance.

### 3b.5 Easy/Hard proof strategy: no distinction

The LaTeX prove skill carefully calibrates output length by difficulty (Easy: 3–8 lines; Hard: 20+). The Lean phase makes no such calibration. Every theorem goes through full sketch→fill→verify regardless of whether the Lean proof is `by norm_num` (1 line) or a 50-line induction.

An obvious win: before the sketch phase, add a "classify Lean difficulty" prompt that produces one of:
- `trivial` → attempt `by decide`/`norm_num`/`ring`/`omega` directly (no sketch needed)
- `tactic` → standard sketch→fill pipeline
- `structural` → sketch→fill with induction/recursion guidance

Trivial proofs currently waste 3–6 API calls going through sketch→fill when a 1-call `by norm_num` attempt would succeed. A rough classifier (even a keyword heuristic on the natural proof text) would save this.

### 3b.6 Summary of prompt engineering gaps

| Gap | Severity | Quick or Medium fix |
|-----|----------|---------------------|
| Zero-shot Lean system prompt (1 sentence) | Critical | Q: expand LEAN_SYS |
| No Lean 3 vs Lean 4 syntax guards | High | Q: add to LEAN_SYS |
| No tactic hierarchy guidance | High | Q: add to LEAN_SYS |
| `contextPrompt.slice(0, 800)` in fill/diagnose | Critical | Q: remove truncation |
| No few-shot Lean examples in any prompt | High | S: add 1–2 examples |
| No Lean-specific skill file | High | M: create fermat-lean-sketch SKILL.md |
| No Lean-reformulation step | Medium | M: add pre-sketch LLM call |
| No easy/hard proof strategy split | Medium | M: add classifier |

---

## 4. Comparison to SOTA

| Feature | Fermat today | Numina-Lean-Agent | Hilbert | Mechanic |
|---|---|---|---|---|
| **Goal state access** | None (regex on stderr) | LSP `$/lean/plainGoal` | LSP + elaborated types | Per-sorry extracted subgoal |
| **Prompt priming** | 1-sentence system | Lean 4 idiom priming + mathlib conventions | Same + semantic retrieval header | Task-focused system per stage |
| **Few-shot examples** | None | 2–3 per phase | 3+ with retrieved neighbors | Per-stage examples |
| **Retrieval** | Char-slice of LaTeX doc | Nearest-mathlib-lemma via embedding | Embedding + TF-IDF over mathlib docstrings | Embedding over mathlib signatures |
| **Recursive decomposition** | No (flat sorry list) | One level (sub-tactics) | Multi-level (theorem → sub-lemmas → tactics) | One level (sub-goals) |
| **Sorrification strategy** | Sketch → fill by position | Fill in elaboration order | Recursive: prove sub-lemmas first, compose | **Extract-Assess-Fix:** isolate failing subgoal with minimal deps, fix in isolation, splice back |
| **Retry diversification** | Same diagnose prompt N times | Best-of-k with different temperatures | Tree search over tactic choices | Strategy escalation: tactic → reformulate → decompose |
| **Parallel attempts** | Serial only | Parallel chains + racing | Parallel sub-goals | Parallel subgoal fixes |
| **Incremental verify** | Full compile each time | LSP incremental | LSP incremental | REPL env-based incremental |
| **Proof caching** | None | Session-level verified theorems | Persistent theorem store | Per-attempt memoization |
| **Tool integration** | None | `exact?`, `apply?`, `aesop`, `polyrith` via LSP | Same + LeanSearch + Loogle | Tactic mix via REPL |

### 4.1 Numina-Lean-Agent — multi-chain + LSP

**What it is:** An agent that uses Lean's language server for goal-aware step planning, spawns **k parallel tactic attempts** at each step, and races their verifications. When a tactic sequence fails, it falls back to an alternate chain without re-doing shared work.

**Cheap-to-borrow ideas:**
- **Best-of-k sampling at each retry.** Sample 2–3 candidates at `temperature=0.7`, verify all, keep first success. Costs ~2× tokens per retry, wins ~1.5× success rate in typical LLM benchmarks.
- **Racing** via `Promise.race` over concurrent `leanRunner.verify` calls — with R-1 (REPL workers) this becomes free.

**Expensive-to-borrow:**
- The full multi-chain tactic planner (search tree over tactic space) is a project of its own.

### 4.2 Hilbert (Apple) — semantic retrieval + recursive decomposition

**What it is:** Uses a pre-computed semantic index over mathlib (theorem statements, docstrings, type signatures) with embedding-based retrieval at proof time. For each subgoal, retrieves the top-k relevant lemmas and shows them in-context. Decomposition is recursive: the high-level prompt is "prove T"; if it fails, break into sub-lemmas, prove each, and compose.

**Cheap-to-borrow:**
- **Embed mathlib's signature index once, ship with the app.** At fill time, embed the current goal, retrieve top-k signatures by cosine similarity, inject into the prompt. Index is a few hundred MB but can be lazy-loaded and cached. There are open-source embeddings for this (e.g. [LeanDojo](https://leandojo.org/)'s pre-computed index).
- **Docstring-aware retrieval.** Mathlib's docstrings are high-signal. A BM25 index over docstrings is even cheaper than embeddings and surprisingly effective for "lemma that mentions `gcd`" queries.

**Expensive-to-borrow:**
- Full recursive decomposition. Requires goal state (R-2) and a planner that can emit a sub-theorem and recurse. This is arguably the most impactful but highest-effort idea; doing it well requires LSP-level integration.

### 4.3 Mechanic (sorrifier) — 3-stage extract-assess-fix

**What it is:** When a proof attempt fails, instead of feeding the whole failure back to the model, Mechanic:
1. **Extract** — isolate the failing subgoal. Sorrify everything else. Pull out the minimum imports + hypotheses needed for just that subgoal.
2. **Assess** — judge the sub-problem in isolation. Is it likely solvable? What tactic family fits (arithmetic → `omega`/`linarith`; equalities → `ring`/`rfl`; finite cases → `decide`/`fin_cases`; existential → structured `use`)?
3. **Fix** — attempt the assessed tactic family. Splice the fix back into the full proof.

Fermat's current pipeline is morally a 2-stage (sketch → fill) — the sorrifier name in the audit is aspirational. The actual "sorrify" step in [`_leanSketchFillVerify`](src/main/claude-code-backend.js:266) just continues editing the whole file on retry; it doesn't isolate the subgoal into a minimal reproducer.

**Cheap-to-borrow:**
- **Minimal-context fix prompts.** When a sorry fails, synthesize a standalone Lean snippet containing only the enclosing `theorem` signature + the failing `sorry` (everything else stubbed/sorried). Send *that* to the model. Smaller prompt, fewer distractors, measurably better outcome.
- **Goal-class heuristic routing.** A simple classifier ("goal is arithmetic over ℕ" → try `omega` first; "goal is equality of terms" → try `ring`/`rfl`; etc.) before even asking the model.

**Expensive-to-borrow:**
- True automatic extraction (finding the minimum set of hypotheses that the sub-goal actually needs) requires LSP-level dependency analysis.

### 4.4 Fermat-specific fit

Fermat's UX (paused statement review; sorry-by-sorry fill; visible per-sorry status in LeanPanel) is **already architecturally close** to a Mechanic-style sorrifier. The missing pieces are: minimal context per fill (Mechanic), retrieved relevant lemmas (Hilbert), diversified retries / racing (Numina).

The **single biggest architectural debt** — batch compile vs LSP/REPL — blocks all three. Invest there first.

---

## 5. Prioritized roadmap

### 5.1 Quick wins (<1 day each)

| ID | Change | File | Why it's cheap | Estimated impact |
|----|--------|------|---------------|------------------|
| P-1 | Expand system prompt to ~200 words with Lean-4 idioms + tactic decision tree | `claude-code-backend.js:270` | Single string edit | 10–20% fewer first-try failures |
| P-2 | Add 1–2 few-shot examples to sketch + fill + diagnose | `claude-code-backend.js:529,583,609` | Three prompt-template edits | 15–25% better structural correctness on sketch |
| P-7 | Code-region-aware sorry counter | `claude-code-backend.js:381,425` | 30 LOC state machine | Removes a class of false-retry bugs |
| P-8 | Replace `_parseTheoremStatement` regex with bracket-aware scanner | `claude-code-backend.js:635` | 50 LOC | Fixes term-mode + `where` cases |
| P-9 | Hash-keyed verify cache (session scope) | `lean-runner.js:155` | Map + sha256 of source | Medium latency win during retry loops |
| P-10 | Heuristic sorry ordering (simplest first) | `claude-code-backend.js:379` | 10 LOC sort predicate | 5–10% more proofs complete |
| W-5 | Move temp files to `_verify/<uuid>/` subdirs | `lean-runner.js:197,173` | 10 LOC | Hygiene; unblocks W-2 |
| W-6 | Startup sweep of stale temp files | `lean-runner.js:80` | 3 LOC in constructor | Hygiene |
| R-7 | Richer `LeanError` with `kind` | `lean-runner.js:29,249` | Regex + switch | Unlocks smarter diagnose routing |
| U-11 | `(n/total sorries filled)` in LeanPanel header | `LeanPanel.jsx` | Already partly wired; emit `sorries` in `lean-filling` events | UX clarity |

**Total:** roughly **3–4 days of focused work** gets every quick-win, and this alone should materially improve completion rate + latency.

### 5.2 Medium (1–3 days each)

| ID | Change | Prerequisite | Why medium effort | Impact |
|----|--------|--------------|-------------------|--------|
| P-3 | Goal-state dump via `set_option pp.all true` + `#check` / `#print` probes after sketch verifies | Quick wins | Requires a second verify pass + output parser; no LSP needed | **High** — unblocks real hypothesis context for fills |
| P-4 | Diversified retry strategies (attempt 2 = different tactic family, attempt 3 = decompose-first) + optional 2-sample racing at `temp=0.7` | P-3 | New prompt variants + concurrency plumbing (already have abort signals) | Medium-high |
| P-5 | Structured `contextPrompt` with dependency-aware priority | — | Refactor `ContextAssembler` output shape + update 3 prompt builders | Medium |
| W-1 | "Update Mathlib" Settings action + progress streaming | — | New IPC handler + `lake update && lake exe cache get` process + progress events | Very high for retention |
| W-2 | Persistent `UserTheorems.lean` that accumulates accepted proofs and is imported into future sessions | W-5 | Append-and-rebuild flow; version conflicts when proof is edited | Compounding |
| W-4 | Include accepted theorems in Lean context, not just LaTeX | W-2 | `ContextAssembler` change + sketch prompt edit | High |

### 5.3 Large (1 week+)

| ID | Change | Why large | Unlocks |
|----|--------|-----------|---------|
| R-1 / R-4 / R-6 | **Replace batch-compile LeanRunner with `repl`-based persistent-server runner.** Pool of N workers, each with mathlib prelude pre-loaded, env-ID tracked, communicating via line-delimited JSON-RPC. | New module (~400 LOC), protocol handling, pool lifecycle, error recovery, graceful fallback to batch mode | 3–10× faster verify; unlocks R-2, R-3, P-3's proper implementation |
| R-2 / R-3 | Goal-state query + tactic-suggestion API on top of REPL | Requires R-1 | Proper minimal-context fills; `exact?`/`apply?` integration |
| "Mechanic mode" | Full minimal-context sorrifier: each failed fill becomes a standalone snippet with only the deps it needs, fixed in isolation, spliced back | Requires R-2 + dependency analysis | Mechanic-level quality for the hard cases |
| "Hilbert mode" | Semantic retrieval over mathlib signature index | Vector DB, embedding model (maybe local), precomputed index shipped with the app | Unlocks Hilbert-level lemma discovery |
| Recursive decomposition | Proof planner that can emit sub-theorems and recurse | Requires goal state + a planner loop with termination | State-of-the-art on hard problems |

### 5.4 Suggested sprint shape

**Sprint 1 (week of):** quick wins batch (P-1, P-2, P-7, P-8, P-9, P-10, R-7, W-5, W-6, U-11). Measurable by first-try success-rate dashboard. One commit per item or one stacked PR.

**Sprint 2:** P-3 goal-state probe + P-4 diversified retries. Ship behind a feature flag (`verification.advanced = true`) so degraded performance is reversible.

**Sprint 3:** W-1 + W-2 + W-4 (mathlib update + user-theorem persistence). High-retention wins.

**Sprint 4+:** R-1 REPL migration. This is the inflection point — after this, SOTA features become reasonable.

---

## Appendix A — Concrete file:line map

| Concern | File | Line |
|---------|------|------|
| Pipeline entry | `src/main/claude-code-backend.js` | [168](src/main/claude-code-backend.js:168) |
| `_leanSketchFillVerify` | `src/main/claude-code-backend.js` | [266](src/main/claude-code-backend.js:266) |
| System prompt (`LEAN_SYS`) | `src/main/claude-code-backend.js` | [270](src/main/claude-code-backend.js:270) |
| Sketch retry count | `src/main/claude-code-backend.js` | [282](src/main/claude-code-backend.js:282) |
| Fill retry count | `src/main/claude-code-backend.js` | [397](src/main/claude-code-backend.js:397) |
| Sorry progress check | `src/main/claude-code-backend.js` | [381, 425](src/main/claude-code-backend.js:381) |
| `_buildSketchPrompt` | `src/main/claude-code-backend.js` | [529](src/main/claude-code-backend.js:529) |
| `_parseSorries` | `src/main/claude-code-backend.js` | [565](src/main/claude-code-backend.js:565) |
| `_buildFillPrompt` | `src/main/claude-code-backend.js` | [583](src/main/claude-code-backend.js:583) |
| `_buildDiagnosePrompt` | `src/main/claude-code-backend.js` | [609](src/main/claude-code-backend.js:609) |
| `_parseTheoremStatement` | `src/main/claude-code-backend.js` | [635](src/main/claude-code-backend.js:635) |
| `LeanRunner.verify` | `src/main/lean-runner.js` | [155](src/main/lean-runner.js:155) |
| `_verifyWithMathlib` temp file | `src/main/lean-runner.js` | [197](src/main/lean-runner.js:197) |
| `_runLean` timeout | `src/main/lean-runner.js` | [231](src/main/lean-runner.js:231) |
| Error regex | `src/main/lean-runner.js` | [29](src/main/lean-runner.js:29) |
| `_detectMathlibCache` | `src/main/lean-runner.js` | [348](src/main/lean-runner.js:348) |
| Mathlib pin | `lean-workspace/lakefile.toml` | (mathlib @ v4.29.0) |

## Appendix B — External references

- [leanprover-community/repl](https://github.com/leanprover-community/repl) — minimal Lean REPL, line-delimited JSON.
- [LeanDojo](https://leandojo.org/) — pre-computed mathlib embedding index, trace datasets.
- [Lean 4 Language Server docs](https://leanprover-community.github.io/mathlib4_docs/) — `$/lean/*` JSON-RPC extensions.
- `mathlib4/Mathlib/Tactic/Find.lean`, `Loogle`, `exact?` — in-editor lemma search tactics; programmable.

---

## TL;DR

1. **Three quick-win days** (expanded system prompt, few-shot examples, goal-state probe via `#check`, code-region-aware sorry counter, verify cache, better error taxonomy, startup hygiene) get most of the way to Hilbert/Mechanic prompt quality.
2. **One medium week** (mathlib updater + user-theorem persistence + structured context) fixes the session-over-session degradation.
3. **One big bet** (REPL-backed persistent Lean runner) unlocks the remaining SOTA features — real goal state, 3–10× latency, parallel racing, tactic suggestions.

The quick-wins are strictly dominated — do them. The REPL migration is the highest-leverage large project. Mechanic-style minimal-context sorrifier and Hilbert-style semantic retrieval are both good ideas that sit on top of the REPL migration, so they're Sprint 5+ items.
