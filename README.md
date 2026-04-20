# Fermat

> *The proof is no longer too large for the margin.*

Fermat is an AI-powered LaTeX editor for proving theorems. Write your theorem, add a `% [PROVE IT: Easy|Medium|Hard]` marker, and let Claude prove it — with a full 3-phase pipeline: sketch → prove → verify.

---

## Screenshot

<!-- TODO(xingyu): replace with actual screenshot -->
![Fermat editor screenshot](docs/screenshot.png)

---

## Installation

```bash
git clone https://github.com/TODO/fermat.git   # TODO(xingyu): fill repo URL
cd fermat
npm install
```

### API key configuration

Fermat calls the Anthropic API directly when the Claude Code CLI is not installed. Set your key in **Settings** (gear icon in the toolbar), or export it before launching:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

The key is stored locally via `electron-store` and never leaves your machine.

---

## Running in development

```bash
npm run dev          # starts Vite dev server (port 3000) + Electron
```

To run just the renderer (useful for inspecting the UI in a browser):

```bash
npm run dev:renderer
```

---

## First proof

1. Open Fermat (`npm run dev`).
2. The editor starts with a sample LaTeX document containing three proof markers.
3. Click **"Submit All"** in the toolbar (or open your own `.tex` file first).
4. Easy proofs are inserted automatically; Medium/Hard proofs appear in the **Review Panel** on the right for you to accept, edit, or reject.

To add a marker to your own document:

```latex
\begin{theorem}[Infinitude of Primes]
\label{thm:inf-primes}
There are infinitely many prime numbers.
\end{theorem}
% [PROVE IT: Easy]
```

Supported difficulties: `Easy`, `Medium`, `Hard`.

You can also include a proof sketch hint:

```latex
% [PROVE IT: Hard]
% SKETCH: Two parts — existence by induction, uniqueness via Euclid's lemma.
```

See the [`examples/`](examples/) directory for complete sample documents.

---

## Lean environment setup

Fermat uses [Lean 4](https://leanprover.github.io/lean4/) for formal proof verification. Lean is optional — the LaTeX proof pipeline works without it — but required for the Lean sketch→fill→verify pipeline.

### 1. Install elan (Lean version manager)

```bash
curl https://elan.lean-lang.org/elan-init.sh -sSf | sh
```

Restart your shell, then verify:

```bash
lean --version    # Lean (version 4.x.y, ...)
elan --version    # elan 4.x.x
```

elan installs lean to `~/.elan/bin/lean`. Fermat detects this path automatically — no manual configuration needed for basic Lean verification.

### 2. Build the Mathlib cache (for Mathlib support)

Mathlib-backed proofs require a pre-built `.olean` cache (~7 GB). From the repo root:

```bash
cd lean-workspace
lake exe cache get    # downloads pre-built Mathlib oleans (~7 GB, one-time)
```

This takes 10–30 minutes on first run depending on bandwidth. Once done, Fermat detects the cache automatically and enables the **Mathlib mode** toggle in Settings.

> **Lean toolchain:** `lean-workspace/lean-toolchain` pins a specific Lean version for Mathlib compatibility. elan switches to that version automatically when running inside the workspace.

### 3. Configure in Fermat

Open **Settings** (gear icon) → **Lean** tab:

| Setting | Default | Notes |
|---|---|---|
| Lean binary path | auto-detected | Leave blank to use `~/.elan/bin/lean`; set an explicit path if using a custom install |
| Use Mathlib | off | Enable after completing step 2 |
| Use persistent REPL | off | Keeps Mathlib loaded in memory — eliminates ~30 s cold-start per verification; requires Mathlib mode |

---

## Distribution build

```bash
npm run dist
```

Output goes to `release/`. Targets:

| Platform | Format |
|----------|--------|
| macOS    | DMG (x64 + arm64) |
| Windows  | NSIS installer (x64) |
| Linux    | AppImage (x64) |

**Before your first dist build**, generate platform icons:

```bash
npm run gen-icons   # generates build/icon.png
# macOS ICNS: iconutil -c icns <iconset>  (or electron-icon-builder)
# Windows ICO: convert build/icon.png build/icon.ico  (ImageMagick)
```

For macOS notarization, uncomment `afterSign` in `package.json` and set:

```bash
export APPLE_ID=...
export APPLE_TEAM_ID=...           # TODO(xingyu): fill
export APPLE_APP_SPECIFIC_PASSWORD=...
```

---

## Architecture

```
fermat/
├── src/
│   ├── main/                  # Electron main process (Node.js)
│   │   ├── main.js            # Window creation, IPC handlers
│   │   ├── copilot-engine.js  # Proof task queue & orchestration
│   │   ├── claude-code-backend.js  # Claude CLI / direct API backend
│   │   ├── context-assembler.js    # Structured context for proofs
│   │   └── tex-compiler.js    # pdflatex / xelatex / lualatex runner
│   └── renderer/              # React UI (Vite)
│       ├── components/        # App, TexEditor, PdfViewer, ProofReviewPanel …
│       └── hooks/             # useCopilot, useOutline
├── .claude/skills/            # Fermat skill prompts
│   ├── fermat-sketch/         # Phase 1: plan the proof strategy
│   ├── fermat-prove/          # Phase 2: write the full LaTeX proof
│   └── fermat-verify/         # Phase 3: LLM-as-judge verification
├── examples/                  # Sample .tex documents with PROVE IT markers
├── fermat-skills-workspace/   # Eval benchmark results
└── landing/                   # Static landing page
```

### Proving pipeline

For each `% [PROVE IT: X]` marker:

1. **Sketch** *(Medium/Hard only)* — `fermat-sketch` plans the approach, surfaces prerequisites.
2. **Prove** — `fermat-prove` writes a rigorous `\begin{proof}…\end{proof}` block using full document context.
3. **Verify** — `fermat-verify` checks the proof; if it fails, Fermat retries with the feedback (once).
4. Easy proofs are auto-inlined; Medium/Hard go to the **Review Panel**.

The backend prefers the **Claude Code CLI** (`claude --print`) for agent-level reasoning; it falls back to the **Anthropic SDK** (direct API) when the CLI is not installed.

---

## License

MIT © TODO(xingyu)
