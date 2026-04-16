# Fermat — Editor Semantics Audit & Lean Support Design

> Last updated: 2026-04-16  
> Status: design / audit only — no code changed

---

## Part A — Editor File-Operation Semantics Audit

### A.1 What's already correct

| Behaviour | Where | Notes |
|-----------|-------|-------|
| **Save** falls back to Save-As dialog when `filePath` is null | `main.js:142–152`, `App.jsx:299–303` | IPC receives `{filePath, content}`; if `filePath` is falsy, shows `showSaveDialog`; returned path is stored in state. ✓ |
| **Open** dialog → read → `content` + `filePath` updated atomically | `main.js:131–140`, `App.jsx:268–275` | Single `file:open` round-trip; state set on success only. ✓ |
| **Open Folder** auto-opens first `.tex` file | `App.jsx:277–290` | Sorts `main.tex` first; sensible default. ✓ |
| **File picker** dropdown in multi-file mode | `Toolbar.jsx:53–103` | Active file highlighted, folder name shown. ✓ |
| `file:save` returns the final path so the renderer can update `filePath` after first save | `main.js:151` | Handles the case of saving an untitled doc. ✓ |
| `Cmd+S` wired inside Monaco editor | `App.jsx:473` (`onSave` prop → `TexEditor`) | Monaco intercepts `Ctrl/Cmd+S` when the editor has focus. Functionally works. ✓ |
| `Cmd+B` (Compile) works inside editor | `App.jsx:474` (`onCompile` prop → `TexEditor`) | Same mechanism. ✓ |

---

### A.2 Missing or wrong — ordered by severity

#### 🔴 Critical

**1. No dirty-state tracking**  
`App.jsx` has no `dirty` / `isDirty` state. Nothing marks the document as changed after an edit. Consequences:
- Window title is always `Fermat` (hardcoded in `main.js:59`). No `•` indicator.
- No "unsaved changes" prompt on window close — data loss risk.
- No "unsaved changes" prompt when `Open` or `Open Folder` replaces editor content.
- No "unsaved changes" prompt when switching files inside a folder via the dropdown.

The `window-all-closed` handler in `main.js:267` quits immediately; there is no `close`-event intercept to check dirty state.

**Fix surface:** set `dirty = true` in `onChange`; reset on successful save. In main, handle `mainWindow.on('close', e => { if dirty → `e.preventDefault()` → show native dialog → if confirmed → `mainWindow.destroy()` })`. Update `mainWindow.setTitle(...)` from renderer via `ipcRenderer.send('window:set-title', ...)`.

---

#### 🟠 High

**2. No "New File" command anywhere**  
No `handleNew`, no IPC handler, no toolbar button, no keyboard shortcut. Users cannot start a fresh document without reloading the app or manually clearing everything. The sample `SAMPLE_TEX` constant stays loaded until the user opens a file.

Needed:
- `handleNew` in `App.jsx`: dirty check → `setContent('')` → `setFilePath(null)` → `setFolderPath(null)` → `setFolderFiles([])`.
- Toolbar button + `Cmd+N` keyboard shortcut.

**3. No "Save As" command**  
`handleSave` always forwards the existing `filePath` to `file:save`. If `filePath` is set, it silently overwrites in-place — there is no way for the user to invoke "save to a new location" without first clearing state. `Cmd+Shift+S` is not wired anywhere.

Needed:
- `handleSaveAs` that passes `filePath: null` to `file:save` regardless of current state.
- Toolbar item (can live in a File menu) + `Cmd+Shift+S`.

---

#### 🟡 Medium

**4. Keyboard shortcuts not registered at the OS / menu-bar level**  
`Cmd+S`, `Cmd+O`, `Cmd+N`, `Cmd+Shift+S` exist only as Monaco internal bindings or tooltip hints. They do **not** work when focus is outside the Monaco editor (e.g., focus is in the PDF panel, the outline, or a dialog). Electron's `Menu.buildFromTemplate` / `globalShortcut` is never called in `main.js`.

Needed: register an `applicationMenu` with standard File items that call the appropriate IPC handlers, so shortcuts work app-wide.

**5. No dirty check before Open / Switch File**  
`handleOpen`, `handleOpenFolder`, and `handleSelectFile` all replace `content` + `filePath` immediately with no guard. Any unsaved edits to the current file are silently discarded.

Fix: add `if (dirty) { confirm? }` gate in each handler (can reuse a shared `confirmDiscard()` helper).

---

#### 🔵 Low / Info

**6. Window title never reflects current filename**  
`createWindow()` hardcodes `title: 'Fermat'`. Even after opening `my-paper.tex`, the window title stays `Fermat`. VS Code / TeXShop both show `filename — AppName`. Needs a renderer→main IPC call (`window:set-title`) after every `filePath` change.

**7. `file:save` dialog offers only `.tex` extension**  
`file:open` filters accept `.tex .sty .cls .bib`, but `file:save` only offers `.tex`. If a user opens `macros.sty` and saves it, the dialog still defaults to `.tex`. Fix: copy the same filter array to `file:save`.

**8. No recent files**  
Could use Electron's native `app.addRecentDocument` / `app.getFileIcon` + a "Recent" submenu in the File menu. Optional but standard UX.

**9. No external-modification detection**  
If the same `.tex` file is edited in another editor and saved, Fermat shows the stale in-memory copy with no warning. Fix: `fs.watch` on `filePath`; send an IPC event to renderer; show an infobar. Optional.

---

### A.3 Audit summary table

| Feature | Status | Severity |
|---------|--------|----------|
| Save (overwrite) | ✅ works | — |
| Save As (new location) | ❌ missing | High |
| Open file | ✅ works | — |
| New file | ❌ missing | High |
| Dirty state + `•` title | ❌ missing | **Critical** |
| Discard-changes prompt on Open/Switch/Close | ❌ missing | **Critical** |
| Cmd+S (inside editor) | ✅ works via Monaco | — |
| Cmd+S (outside editor) | ❌ not wired | Medium |
| Cmd+Shift+S | ❌ missing | High |
| Cmd+N | ❌ missing | High |
| Cmd+O (outside editor) | ❌ not wired | Medium |
| Window title = filename | ❌ hardcoded | Low |
| Save dialog extension filter | ⚠️ tex only | Low |
| Recent files | ❌ missing | Info |
| External modification detection | ❌ missing | Info |

---

---

## Part B — Lean 4 Support Design

### B.1 Overview

The user wants an opt-in toggle: "use Lean in the backend?" with a corresponding frontend panel if enabled. This section designs the complete feature without prescribing implementation order.

---

### B.2 Backend Mode — `verificationMode` field

#### Decision: use `verificationMode` on the copilot config, not per-request

Lean verification is a global environment choice (binary availability, `lake` project setup, retry budget), not something that varies marker-by-marker in normal use. It belongs in Settings, not in the proof request.

```js
// Added to the config object sent via copilot:configure
{
  verificationMode: "off" | "lean",   // default: "off"
  lean: {
    binaryPath: "",          // empty → auto-detect from PATH; or absolute path
    maxRetries: 3,           // how many LLM→lake→retry cycles before giving up
    timeout: 60,             // seconds per lake build attempt
  }
}
```

**Why `"off" | "lean"` and not three values?**  
The user asked for an opt-in toggle. A third value `"lean-only"` (no LaTeX, only Lean) would require a different compilation pipeline and UI layout — scope creep for now. If needed later it can be added as a third enum value without breaking the existing two. Keep it simple today.

Per-theorem override (for power users): a marker can carry `skipLeanVerify: true` to get a fast draft without the full build loop. This is additive and optional.

---

### B.3 Backend: Lean verify loop

```
submitProofRequest(marker)
  │
  ├─ verificationMode === "off"  → existing LaTeX-only path (unchanged)
  │
  └─ verificationMode === "lean"
       │
       ├── 1. Claude generates Lean 4 proof code
       ├── 2. Write to temp .lean file inside a lake project skeleton
       ├── 3. Spawn `lake build` (with timeout)
       ├── 4a. build OK  → emit proof:completed with {leanCode, buildLog}
       └── 4b. build FAIL
             ├── retry < maxRetries
             │     └── append error to prompt → go to step 1
             └── retry >= maxRetries → emit proof:failed with full build log
```

#### IPC events — additions to existing schema

```js
// Already exists:
copilot:proof-streaming   { markerId, chunk }
copilot:proof-completed   { markerId, proof }
copilot:proof-failed      { markerId, error }
copilot:proof-status      { markerId, ... }

// New / extended:
copilot:lean-build-started  { markerId, attempt }       // lake build began
copilot:lean-build-output   { markerId, line }          // stdout/stderr stream
copilot:lean-build-done     { markerId, attempt, success, exitCode, durationMs }
```

Streaming `lake build` output line-by-line lets the frontend display a live log without waiting for the full build.

#### Finding the Lean binary

Priority order (checked at `copilot:configure` time):
1. `lean.binaryPath` from settings (absolute path, user-specified)
2. `which lean` / `where lean` on PATH
3. `~/.elan/bin/lean` (default elan install location)

If none found and `verificationMode === "lean"`, emit a warning event to renderer and degrade gracefully (don't crash).

#### Lake project skeleton

A minimal `lakefile.lean` is generated at compile time into a temp dir (or a persistent `.fermat-lean/` subfolder of the open folder if one exists). The skeleton imports `Mathlib` only if `lean.usesMathlib: true` in config (see §B.5).

---

### B.4 Frontend — Lean Panel

#### Decision: tabbed right panel (PDF ↔ Lean), not a new split

**Current right-side layout:**
```
[Outline sidebar] | [Editor] | [PDF panel]
```

Adding a fourth horizontal split would make the editor too narrow on typical 13–15" laptops. A tabbed right panel costs zero horizontal space:

```
[Outline sidebar] | [Editor] | [PDF | Lean] ← tab switcher
```

- The tab switcher appears in the PDF toolbar area when `verificationMode === "lean"`.
- Default tab: PDF (no change to existing workflow).
- Switching to Lean tab mounts `<LeanPanel />` in place of `<PdfViewer />`.
- The toggle is only rendered if `verificationMode === "lean"` (no visual noise when Lean is off).

#### `LeanPanel` component — contents

```
┌─────────────────────────────────────────────────────┐
│ [theorem label]       attempt 2/3   ⬛ cancel       │  ← header
├─────────────────────────────────────────────────────┤
│ ▶ Generated Lean code                               │
│   theorem infinitude_of_primes : ...                │  ← collapsible Monaco
│     ...                                             │    read-only, Lean syntax
├─────────────────────────────────────────────────────┤
│ lake build output                    ✗ exit 1       │
│  > error: unknown tactic `ring'      line 12        │  ← scrollable log
│  > ...                                              │
├─────────────────────────────────────────────────────┤
│ [Accept proof]  [Reject]  [Retry manually]          │  ← action row
└─────────────────────────────────────────────────────┘
```

**Error line → source mapping:**  
`lake build` error messages contain `.lean:LINE:COL` references. Parse these and display clickable links that call `editorRef.revealLineInCenter(line)` to jump to the corresponding position in the LaTeX source. Mapping is approximate (Lean line ≈ clause position in generated code); a comment header in the generated file can anchor known positions.

**Monaco Lean syntax highlight:**  
Use `monaco-editor`'s TextMate grammar loading (`monaco-tm-grammar`) with the Lean 4 grammar from [`leanprover/vscode-lean4`](https://github.com/leanprover/vscode-lean4) (MIT license). This is **read-only syntax colouring only** — no LSP, no IntelliSense. Full LSP (`lean4-mode`) is out of scope for this iteration.

---

### B.5 Local Environment Installation Plan

#### Decision: **mathlib default = NO (opt-out of auto-install)**

Mathlib is >15 GB of compiled `.olean` files and takes 30–60 minutes to build from source on first install. The vast majority of theorem-proving use cases in a LaTeX paper (Euclidean geometry, basic number theory, calculus) need only `Lean 4 core` + `Std4`. Installing mathlib by default would:
- Stall first-run for 30–60 minutes with no clear progress
- Consume 15+ GB of disk without user consent
- Add `import Mathlib` overhead to every build (~3s cold start even with cache)

mathlib should be opt-in via a checkbox in Settings: `"Import Mathlib (large download ~15 GB, first build ~30 min)"`.

#### Installation sequence

```
1. Check for elan (Lean version manager)
   → if missing: prompt user → link to https://leanprover.github.io/lean4/doc/setup.html
   → Fermat does NOT auto-install elan (requires shell modification, security concern)

2. User installs elan manually; restarts Fermat
   → Fermat re-detects lean binary

3. Fermat auto-initialises a lake project skeleton in .fermat-lean/ on first use
   → lakefile.lean with require "std" (core only)
   → if usesMathlib=true: require "mathlib" + runs `lake exe cache get` in background
      with progress streamed to the Lean panel log

4. On every proof attempt: lake build of the single generated theorem file
   → cold: ~2–5 s (Std4); with cache: <1 s
   → with Mathlib cold: ~3–10 s; cached: ~2–3 s
```

#### dev vs bundled-app strategy

| Context | lean binary source | lake project |
|---------|-------------------|-------------|
| `npm run dev` | PATH (developer has elan) | `.fermat-lean/` in CWD |
| Packaged `.app` | Settings `lean.binaryPath` OR PATH OR `~/.elan/bin/lean` | `~/.fermat/lean-workspace/` |

The packaged app does NOT bundle lean — it's too large (>200 MB just for the toolchain) and version-locked. Users manage their own lean version via elan.

---

### B.6 Claude prompt augmentation for Lean

When `verificationMode === "lean"`, the proof request to Claude is augmented:

```
System addendum:
"Generate a Lean 4 proof. Output only valid Lean 4 code inside a ```lean4 fence.
Available imports: Lean.Core, Std (and Mathlib if usesMathlib=true).
Do not use sorry."

On retry, append:
"The previous attempt failed with the following lake build errors:
<build_stderr>
Please fix the proof."
```

The retry loop tracks:
- `attempt: number` (shown in panel header)
- `buildLog: string[]` (full stderr per attempt, shown in panel)
- A "cancel" button emits `copilot:cancel-proof` (existing IPC, already implemented)

---

### B.7 Settings UI additions

In `SettingsModal`, add a "Lean Verification" section:

```
┌── Lean Verification ─────────────────────────────────┐
│  Mode:  ○ Off   ● Lean 4                             │
│                                                       │
│  [only shown when Lean 4 selected]                    │
│  lean binary path:  [ ~/.elan/bin/lean         ] [✓] │
│  Max retries:  [ 3  ▼ ]   Timeout (s):  [ 60  ]     │
│  □ Import Mathlib  ⚠ ~15 GB, ~30 min first build    │
└───────────────────────────────────────────────────────┘
```

The path field has a "test" button that runs `lean --version` and shows the output inline.

---

### B.8 Iteration / rollout strategy

Suggested implementation order:

1. **Config schema** — add `verificationMode` + `lean` block to `copilot:configure`, store in settings
2. **Binary detection** — util function, call on configure, surface error to renderer
3. **Lake skeleton** — generate `.fermat-lean/` with minimal lakefile on first use
4. **Build runner** — `LeanBuilder` class: write file, spawn `lake build`, stream stdout/stderr via IPC
5. **Retry loop** — wrap builder in retry logic inside `FermatEngine`
6. **LeanPanel component** — tab switcher + log display + code viewer (no LSP yet)
7. **Lean syntax highlight** — add grammar after panel is functional
8. **Mathlib opt-in** — add checkbox + `lake exe cache get` download flow last

---

## Summary of key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **mathlib default install** | ❌ **NO** — opt-in only | 15 GB / 30 min; most proofs don't need it |
| **Panel position** | **Right panel, tabbed with PDF** | No new split; zero horizontal cost |
| **Backend field** | `verificationMode: "off" \| "lean"` on copilot config | Simple toggle as user requested; `"lean-only"` deferred |
| **lean binary management** | User installs elan; Fermat reads from PATH / settings | Don't bundle binary; too large, version-sensitive |
| **Lean LSP / IntelliSense** | Not in v1 — syntax highlight only | Complexity vs. benefit for read-only generated code |
| **Retry prompt strategy** | Append full `stderr` to next Claude prompt | Simple, effective; matches how humans debug Lean |
| **lake project location** | `.fermat-lean/` beside open folder, or `~/.fermat/lean-workspace/` in packaged app | Reproducible; ties to the project |
