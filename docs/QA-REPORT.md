# Fermat — Hands-on QA Report

Date: 2026-04-17
Commit under test: current working tree
Platform: macOS (Darwin 25.4.0), Electron 41.1.1, Node (main), Vite 5.4.21

Complement to [SOFTWARE-AUDIT.md](./SOFTWARE-AUDIT.md). That report was static;
this one is the result of actually building and running the IPC/event/dep
cross-checks. Severity scale: **Critical** (crash/data-loss/exploit) →
**High** (wrong behaviour) → **Medium** (polish / silent failure) → **Low**.

---

## Executive summary

- `npx vite build` succeeds with one warning (bundle 3.79 MB / 1.00 MB gzip).
- `node --check` passes on every file under `src/main/`.
- `npm ls --depth=0` clean — no missing, no extraneous, no peer-dep warnings.
- Every `ipcMain.handle/on` channel has a matching preload bridge, and every
  `preload` invoke/send hits a registered main handler. **No orphans, no typos.**
- Every `copilotEngine.emit` event is forwarded to the renderer; every `send`
  channel has a renderer subscriber. Zero drift.
- `useEffect` event listeners consistently return cleanup; no obvious renderer
  leak.

**Three real bugs worth fixing before a release, one bundle-size issue, plus
polish items.** Full list below.

---

## 1. Build quality

| Check | Result |
|---|---|
| `npx vite build` | ✅ succeeds in ~4 s |
| `node --check src/main/*.js` | ✅ all 9 files pass |
| `npm ls --depth=0` | ✅ no warnings/errors |
| `package.json` deps vs. imports | ✅ every dep is imported; every import is declared |

Only warning from Vite:

```
(!) Some chunks are larger than 500 kB after minification.
dist/assets/index-*.js  3,791.41 kB │ gzip: 1,002.91 kB
```

See finding **P1-04** below.

---

## 2. Findings

### P1 (High) — ship-blocking or wrong behaviour

#### P1-01  Event-listener leak on macOS re-activate
**File**: [src/main/main.js:277-291](src/main/main.js)
**Description**: `createWindow()` attaches `copilotEngine.on('proof:started', …)`,
`'proof:completed'`, `'proof:failed'`, `'proof:streaming'`, `'proof:status'`
every time it runs. `ensureEngines()` at line 56 guards re-init of the engine,
but the listener wiring at lines 277-291 lives *outside* that guard.

macOS keeps the app alive after the user closes the last window
(`window-all-closed` does not `quit` on darwin — see line 595). Re-clicking
the dock icon fires `activate` → `createWindow()` → engine gets a fresh copy
of each `proof:*` listener on top of the existing ones. After N reactivations,
a single proof emits N `copilot:proof-*` IPC messages, so the renderer sees
duplicate status updates, duplicate toasts on failure, and the running-counter
goes 0→2→4→2 instead of 0→1→0.

**Repro**: run in packaged mode, close the window (⌘W), click the dock icon,
submit a proof. `copilotStatus.running` jumps by 2; fail toasts render twice.

**Suggestion**: move the `copilotEngine.on(...)` block into `ensureEngines()`
(attach once, reference `mainWindow` via a late-bound getter), OR call
`copilotEngine.removeAllListeners('proof:started')` etc. at the top of the
existing block. The listeners should outlive the window, not the engine.

---

#### P1-02  User's model choice ignored on the Claude CLI path
**File**: [src/main/claude-code-backend.js:666](src/main/claude-code-backend.js), [src/main/claude-code-backend.js:491](src/main/claude-code-backend.js)
**Description**: `_runClaude()` hardcodes `['--print', '--model', 'claude-sonnet-4-6']`
and does not accept a `model` parameter. `_callLlm(prompt, onStream, apiKey, model, systemPrompt, signal)`
*does* accept `model` and forwards it to the Anthropic SDK on the API path,
but when the CLI is available it calls `this._runClaude(fullPrompt, onStream, signal)`
— dropping `model` on the floor.

Result: if the user installs the `claude` CLI and picks "Claude Opus 4.6" or
"Claude Haiku 4.5" in Settings, their choice is silently ignored — every
proof runs on Sonnet 4.6. `SettingsModal.jsx:119-123` advertises three models;
only one is actually reachable on the CLI path.

**Suggestion**: thread `model` through `_runClaude(prompt, onStream, signal, model)`
and use it for `--model`. Fallback to `'claude-sonnet-4-6'` only when the arg
is missing. One-line change per callsite.

---

#### P1-03  Silent no-op when `verificationMode: 'lean'` but lean binary missing
**File**: [src/main/claude-code-backend.js:167](src/main/claude-code-backend.js), [src/renderer/components/App.jsx:596-614](src/renderer/components/App.jsx)
**Description**: `prove()` enters the lean pipeline only when
`options.verificationMode === 'lean' && options.leanRunner?.isAvailable`.
If the user enables lean mode but has no lean binary installed (or the path in
Settings is wrong), `isAvailable` is `false` and the entire lean block is
skipped. `results.leanCode` stays `undefined`, so `App.jsx:597` (`if (data.leanCode !== undefined)`)
never fires, the Lean tab never appears, and there is **no user-visible
indication that lean didn't run** — the LaTeX proof just arrives normally.

A user who turned on lean verification will reasonably assume the proof was
formally checked. It wasn't.

**Suggestion**: when `verificationMode === 'lean' && !leanRunner.isAvailable`,
emit a `proof:status` with `phase: 'lean-unavailable'` (or throw a classified
warning) so the renderer can show a toast "Lean not found — install or fix
path in Settings". Alternatively, refuse to submit when the precondition
isn't met.

---

#### P1-04  3.79 MB (1.00 MB gzip) main renderer bundle
**File**: [vite.config.js](vite.config.js), output `dist/assets/index-*.js`
**Description**: Vite warns the main chunk exceeds 500 kB. Almost the entire
weight is `monaco-editor`: the build ships 80+ language definitions (abap,
cameligo, freemarker2, lexon, postiats, sparql, systemverilog, wgsl, …) even
though Fermat only uses LaTeX, a hand-registered Monarch grammar.
`vite-plugin-monaco-editor` is loaded with `languageWorkers: ['editorWorkerService']`
but that only limits *workers*, not the language sources imported by
`monaco-editor`'s barrel.

Cold start over a slow connection (or on a low-powered machine) is
correspondingly slow; memory footprint is also higher than needed.

**Suggestion**:
- Import monaco via `monaco-editor/esm/vs/editor/editor.api` + only the
  features you use, skipping the `contrib/*` language registrations, OR
- Use `MonacoEditorWebpackPlugin`-style per-language filtering (the Vite
  plugin takes `languageWorkers` / no language allow-list; drop the plugin
  and configure `build.rollupOptions.output.manualChunks` to split Monaco
  into its own chunk so the main bundle loads first).

This is the single biggest perf win available.

---

### P2 (Medium) — polish / silent risk

#### P2-01  `webPreferences.sandbox` not set
**File**: [src/main/main.js:100-104](src/main/main.js)
**Description**: `BrowserWindow` uses `contextIsolation: true` and
`nodeIntegration: false` (good), but does not set `sandbox: true`. The
preload script therefore runs with Node.js APIs available to it; only the
renderer is isolated. Nothing in `preload.js` *needs* Node (it only uses
`contextBridge` + `ipcRenderer`), so sandbox would tighten defence-in-depth
at zero cost.
**Suggestion**: add `sandbox: true`. Re-run to confirm nothing in the
preload script regresses (it shouldn't).

#### P2-02  No Content Security Policy
**File**: [index.html](index.html)
**Description**: The HTML shell has no `<meta http-equiv="Content-Security-Policy">`.
With `contextIsolation` on and `nodeIntegration` off, XSS impact is limited,
but CSP adds a layer (and prevents accidental inline-script injections if
someone later renders untrusted LaTeX-derived content).
**Suggestion**: add a CSP meta with at minimum
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:`.

#### P2-03  Google Fonts hard dependency
**File**: [index.html:10-12](index.html)
**Description**: Fraunces / Hanken Grotesk / JetBrains Mono are fetched from
`fonts.googleapis.com` and `fonts.gstatic.com`. In a packaged build that
starts offline (first launch on a plane, air-gapped network, etc.), those
requests fail and the UI falls back to system serifs/sans which look
noticeably different from what the design expects.
**Suggestion**: either self-host the font files inside the app bundle
(adds ~1-2 MB), or add a `font-display: swap` CSS rule so the system-fallback
render isn't blocked on the network.

#### P2-04  Dead preload API: `window.api.file.listDir`
**File**: [src/main/preload.js:8](src/main/preload.js), handler at [src/main/main.js:395](src/main/main.js)
**Description**: `file.listDir` is exposed and a main handler exists, but no
renderer code calls it. `file.openFolder` already returns the file list.
**Suggestion**: remove `file.listDir` from preload + its handler from
main.js unless a near-term feature needs it.

#### P2-05  Dead preload API: `window.api.copilot.getStatus`
**File**: [src/main/preload.js:43](src/main/preload.js), handler at [src/main/main.js:470](src/main/main.js)
**Description**: `copilot.getStatus` is exposed; the renderer tracks status
entirely from `proof:*` events inside `useCopilot` and never polls. No
consumer.
**Suggestion**: remove until a real caller appears.

#### P2-06  Duplicate subscription to `copilot:proof-completed`
**File**: [src/renderer/hooks/useCopilot.js:84](src/renderer/hooks/useCopilot.js), [src/renderer/components/App.jsx:596](src/renderer/components/App.jsx)
**Description**: `useCopilot` subscribes to handle task-state bookkeeping;
`App.jsx` subscribes separately to hydrate lean-panel state. Both are wired
correctly and both clean up. Intent is clear, but this is the kind of wiring
that silently drifts — if `useCopilot` ever consumes the event and stops
forwarding, App's effect still runs against the raw IPC, and vice versa.
**Suggestion**: either move lean-state handling into `useCopilot` (returning
`leanState` alongside `proofTasks`), or derive it from `proofTasks` already
in `useCopilot`.

#### P2-07  Silent fallback to `pdflatex` when no engine is detected
**File**: [src/main/tex-compiler.js:51-53](src/main/tex-compiler.js)
**Description**: `_autoDetectEngine` probes `tectonic/pdflatex/xelatex/lualatex`.
If none are found it logs a warning and still sets `this.engine = 'pdflatex'`.
The first compile attempt then fails deep in `execFile` with a generic
ENOENT that's hard to translate into a user-facing message.
**Suggestion**: set `this.engine = null` instead, and have `compile()`
throw a structured "no LaTeX engine installed — install tectonic or MacTeX"
error immediately, with the same toast plumbing used for API auth errors.

#### P2-08  `_detectCli` is synchronous during engine construction
**File**: [src/main/claude-code-backend.js:94-112](src/main/claude-code-backend.js)
**Description**: `execFileSync('which', ['claude'], { timeout: 3000 })` runs
on the main event loop in the ClaudeCodeBackend constructor, which is called
from `ensureEngines()` on `app.whenReady`. On a cold machine / spotlight-
churning laptop, `which` can take a few hundred ms and that window is
unresponsive during that time.
**Suggestion**: swap for an async probe (`new Promise(resolve => execFile('which', ['claude'], cb))`) and let the engine boot with `_hasClaudeCli = false`
until the probe resolves. First proof submitted before the probe completes
falls through to direct-API gracefully.

#### P2-09  `outline-parser.js` and `outline-parser-browser.js` are parallel
**File**: [src/main/outline-parser.js](src/main/outline-parser.js), [src/renderer/utils/outline-parser-browser.js](src/renderer/utils/outline-parser-browser.js)
**Description**: Two separate implementations of what ought to be identical
LaTeX→AST logic, kept in sync by convention. Any change to the main parser
silently diverges the dev/browser fallback.
**Suggestion**: publish the parser as a single no-dependency module that both
sides import. Or document that the browser version is a dev-only stub and
wire `useOutline` to hard-fail when `window.api.outline` is missing (which
would imply a misconfigured build).

#### P2-10  `handleContentChange` re-renders App on every keystroke
**File**: [src/renderer/components/App.jsx:173-176](src/renderer/components/App.jsx)
**Description**: `setContent` + `setIsDirty(true)` run on every Monaco change
event. The resulting re-render cascades down `TheoryOutline`, `PdfViewer`,
`ProofReviewPanel`, the toolbar. Each of those memo-gates internally, so
the DOM work is small, but on a slow machine typing in a large file has
visible lag. (The outline re-parse is already debounced via the
`useEffect` at line 291; good.)
**Suggestion**: keep `content` in a `useRef` and only trigger a debounced
React state update for the components that actually need the content
(outline, PDF compile, copilot). The editor itself doesn't need React to
re-render when its own buffer changes.

---

### P3 (Low) — nit / doc

#### P3-01  Hardcoded model list in SettingsModal
**File**: [src/renderer/components/SettingsModal.jsx:119-123](src/renderer/components/SettingsModal.jsx)
**Description**: Model ids `claude-sonnet-4-6`, `claude-opus-4-6`,
`claude-haiku-4-5-20251001` are inline. When Anthropic ships a new model the
user can't select it without a code change, and misspellings here would only
surface at proof time as an opaque API 404.
**Suggestion**: make this an editable text field + dropdown of known presets,
or fetch the model list at startup.

#### P3-02  `ProofErrorToast` does not auto-dismiss AUTH errors
**File**: [src/renderer/hooks/useCopilot.js:76-80](src/renderer/hooks/useCopilot.js)
**Description**: Intentional (auth errors are sticky so the user sees the
"Open Settings" CTA), but if the user submits 20 markers against a bad API
key they get 20 stacked toasts without any dedupe.
**Suggestion**: coalesce auth-error toasts by `code` so only one is visible
at a time.

#### P3-03  `electron-builder` `files:` array duplicates coverage
**File**: [package.json:22-30](package.json)
**Description**: `dist/**/*` is the built renderer; the `src/renderer/**/*`
entry also packages the unbuilt sources into the app bundle. Either is fine
alone, shipping both bloats the DMG by a few hundred kB for no reason (the
app loads from `dist/` in production — see main.js:131).
**Suggestion**: drop `"src/renderer/**/*"` from `build.files` and keep only
`dist/`, `src/main/`, `public/`, `.claude/skills/`.

---

## 3. Verified **PASS** — checked and found clean

These are things I actively looked at and confirmed are correct, so they don't
get re-litigated on the next audit:

- **IPC channel consistency**: all 31 `ipcMain.handle/on` channels are
  subscribed by preload; all 13 `webContents.send` channels have preload
  `onX` wrappers; no typos, no orphans.
- **Event emitter consistency**: `copilotEngine.emit` → `copilotEngine.on`
  (main forwards) → `webContents.send` → `ipcRenderer.on` (preload) →
  renderer `onProof*` subscribers. Full chain matches for all 5 proof events.
- **`useEffect` cleanup**: every subscription in `App.jsx`, `useCopilot`,
  `LogPanel`, `PdfViewer`, `TexEditor`, `Toolbar`, `LeanPanel`, `SettingsModal`
  returns a teardown that removes listeners / disposes observers /
  clears timeouts.
- **Context isolation**: `contextIsolation: true`, `nodeIntegration: false`
  (see `webPreferences` at [main.js:100-104](src/main/main.js)).
- **Process isolation**: preload only imports `electron.contextBridge` +
  `electron.ipcRenderer` — no `fs`, no `child_process`, no `require` pass-
  through to the renderer.
- **Shell injection**: every child-process spawn uses `execFile`/`execFileSync`/`spawn`
  with an args array, never the string form of `exec`. Argument values are
  controlled by the app, not by the user, across `tex-compiler.js`,
  `lean-runner.js`, `synctex-bridge.js`, and `claude-code-backend.js`.
- **File read sandbox**: `file:read` rejects any path not in the
  approvedReadPaths / approvedReadDirs set ([main.js:370-381](src/main/main.js)),
  so a compromised renderer cannot read `/etc/passwd` via the API.
- **LaTeX-injection-safe markers**: the `[PROVE IT: …]` label is escaped for
  `\fermatprove{}` at [tex-compiler.js:92-107](src/main/tex-compiler.js) —
  backslash, brace, hash, dollar, etc. all neutralised.
- **electron-store defaults**: `defaults: { copilot: { … }, texEngine: 'tectonic' }`
  at [main.js:15-25](src/main/main.js) ensures first-run never produces
  `undefined`.
- **NaN guard on `maxConcurrent`**: [copilot-engine.js:75-78](src/main/copilot-engine.js)
  clamps non-finite values to 1 so `while (running < NaN)` can't silently
  disable the queue.
- **Lean timeout**: [lean-runner.js:214-220](src/main/lean-runner.js)
  SIGTERMs after 120 s, SIGKILLs 1.5 s later. Hung `decide`/`simp` cannot
  lock a concurrency slot forever.
- **PDF cleanup**: [PdfViewer.jsx:84-90, 134-142](src/renderer/components/PdfViewer.jsx)
  destroys the prior `pdfjsLib.getDocument` promise before loading a new PDF,
  and on unmount. No leak across recompiles.
- **AbortSignal propagation**: `FermatEngine.cancelProof` → `task.abortController.abort()`
  → forwarded into the backend as `options.signal`, then into the Anthropic
  SDK stream and the `claude` CLI spawn. Clean cancellation all the way down.
- **No XSS via Monaco**: content flows via `editor.setValue(content)` and
  `onDidChangeModelContent`. No `dangerouslySetInnerHTML`, no eval of user
  content, no HTML sinks.
- **API key masking in logs**: [main.js:457-462](src/main/main.js) —
  keys shorter than 16 chars show only length; longer keys show first 6 +
  last 4.
- **Dependency hygiene**: `package.json` lists exactly the packages that are
  actually `require`d/`import`ed. No phantom deps (the static-audit report's
  mention of `chokidar` and `d3` turned out to be an LLM hallucination —
  neither is present in `package.json` nor imported anywhere).

---

## 4. Error-path spot checks

### 4a. No API key configured
`prove()` at [claude-code-backend.js:160-163](src/main/claude-code-backend.js) —
`if (!this._hasClaudeCli && !options.apiKey)` throws
`'No API key configured and Claude Code CLI not available.'` annotated by
`classifyAndAnnotateError`. Classifies as `NO_API_KEY`, surfaces in the
renderer as a toast with an **Open Settings** CTA. ✅ Correct.

Caveat: if the user has Claude CLI installed AND a bad API key, the CLI path
is used without consulting the API key at all — the bad key is effectively
ignored. Not a bug, just behaviour to document.

### 4b. Lean binary missing
Two paths:

- **Via `lean:verify` IPC (Test button)**: `leanRunner.verify()` short-
  circuits and returns `{ success: false, errors: [{ message: 'lean binary
  not found — check Settings' }] }` at [lean-runner.js:138-145](src/main/lean-runner.js).
  Renders correctly in the Settings panel. ✅
- **Via `prove()` with `verificationMode: 'lean'`**: the lean step is silently
  skipped. See **P1-03** — this is the bug.

### 4c. API 401 / 429 / 500
All classified by `classifyAndAnnotateError` at
[claude-code-backend.js:15-47](src/main/claude-code-backend.js). Mapped to
`AUTH_ERROR`, `RATE_LIMIT`, `API_UNAVAILABLE`, `NETWORK_ERROR` with
user-facing messages. Renderer respects the codes and surfaces the
"Open Settings" button only for auth. ✅

### 4d. Cancel mid-stream
[claude-code-backend.js:502-516](src/main/claude-code-backend.js) aborts
the Anthropic SDK stream controller on `signal.aborted`, and
`_runClaude` SIGTERMs the CLI child then SIGKILLs 1.5 s later
([claude-code-backend.js:682-693](src/main/claude-code-backend.js)). ✅
`FERMAT_CANCELLED` code is recognised by `_executeProof` and turns the task
into `'cancelled'` quietly without a failed-toast ([copilot-engine.js:286-288](src/main/copilot-engine.js)). ✅

---

## 5. Suggested priority order

If you only have a day:

1. **P1-02** — threading `model` through `_runClaude` is a 2-minute fix and
   silently wrong behaviour is the worst kind.
2. **P1-03** — make "lean verification unavailable" a loud failure not a
   silent skip.
3. **P1-01** — the macOS re-activate leak. Two-line fix inside
   `ensureEngines()`.
4. **P1-04** — Monaco bundle trim. Bigger change, but the single largest
   user-facing win after the correctness bugs above.

Everything in P2/P3 can sit until a dedicated polish pass.
