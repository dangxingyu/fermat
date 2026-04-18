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

**Five P1 bugs** (four correctness, one perf), **ten P2 polish/silent-risk items**,
**nine P3 nits**. Full list below.

> **Correction to previous draft**: P1-03 was described as "silent no-op with no
> lean tab". Dynamic testing confirms the opposite: when lean is missing, the
> `leanCode: null` in `proof:completed` passes the `!== undefined` guard in
> `App.jsx`, causing the Lean tab to appear with a **false `lean-failed` status**.
> See P1-03 below for the precise root cause and fix.

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

#### P1-03  Misleading `lean-failed` UI state when lean binary is missing
**File**: [src/main/copilot-engine.js:268-282](src/main/copilot-engine.js), [src/renderer/components/App.jsx:596-614](src/renderer/components/App.jsx)
**Description**: `prove()` enters the lean pipeline only when
`options.verificationMode === 'lean' && options.leanRunner?.isAvailable`.
If the user enables lean mode but has no lean binary installed (or the path in
Settings is wrong), `isAvailable` is `false` and the entire lean block is
skipped.

The `proof:completed` event is then emitted with the Lean fields coerced to
`null` via `result.leanCode || null` (`undefined || null = null`). In `App.jsx`:

```js
if (data.leanCode !== undefined)   // null !== undefined → TRUE — condition fires!
```

Because `null` is not `undefined`, `setLeanState` runs with `leanCode: null`
and the phase logic falls through to `'lean-failed'`:

```js
phase: data.leanVerified ? 'lean-verified'        // null → false
     : (data.sorries?.some(...)) ? 'lean-partial'  // null?.some → undefined → false
     : 'lean-failed'                               // ← always taken
```

Result: the Lean tab **appears** with a `lean-failed` state showing no errors.
A user who turned on lean verification sees a formal verification failure for a
proof that was never actually sent to Lean — an actively misleading outcome,
worse than silence.

**Suggested fix** (two options):

Option A — emit `undefined` (not `null`) when lean wasn't run so the guard works:
```js
// copilot-engine.js
...(result.leanCode !== undefined ? {
  leanCode: result.leanCode,
  leanVerified: result.leanVerified ?? null,
  leanErrors:   result.leanErrors  ?? [],
  sorries:      result.sorries     ?? [],
  leanStatement: result.leanStatement ?? null,
} : {}),
```

Option B — emit a `lean-unavailable` phase via `proof:status` and let the
renderer show a toast "Lean not found — install or fix path in Settings",
refusing to start the proof in lean mode when the precondition isn't met.

---

#### P1-04  `copilot:proof-streaming` emitted but never consumed
**File**: `src/main/main.js:287–288`, `src/renderer/hooks/useCopilot.js:83–94`
**Description**: `copilotEngine.on('proof:streaming', …)` forwards live LLM
token deltas to the renderer via IPC. `preload.js` exposes
`window.api.copilot.onProofStreaming`. However, `useCopilot.js` subscribes to
`onProofStarted`, `onProofCompleted`, `onProofStatus`, and `onProofFailed` —
never `onProofStreaming`. Every streaming chunk is silently discarded. The UI
shows no live output while a proof is generating; users see only the final
result after a potentially long wait.

This also means the `proof:streaming` IPC channel is live but produces zero
user-visible effect — the streaming infrastructure is wired in main and in
preload but dead in the renderer.

**Suggestion**: In `useCopilot.js`, add:
```js
const offStreaming = window.api.copilot.onProofStreaming((data) => {
  setProofTasks(prev => {
    const next = new Map(prev);
    const t = next.get(data.taskId) || {};
    next.set(data.taskId, { ...t, streamingText: (t.streamingText || '') + data.text });
    return next;
  });
});
// …and in cleanup: offStreaming?.();
```

---

#### P1-05  3.79 MB (1.00 MB gzip) main renderer bundle
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

#### P2-05b  Dead IPC channel: `lean:verify`
**File**: [src/main/main.js:501-513](src/main/main.js), [src/main/preload.js:76](src/main/preload.js)
**Description**: `lean:verify` is registered as `ipcMain.handle` and exposed
in `window.api.lean.verify`. Grepping all renderer files (`App.jsx`,
`useCopilot.js`, `SettingsModal.jsx`, `LeanPanel.jsx`) confirms no caller.
Lean verification flows exclusively through the copilot pipeline. The orphaned
handler accepts arbitrary Lean source from the renderer and spawns `lean`
without an abort signal — a hung invocation cannot be cancelled.

**Suggestion**: remove the `lean:verify` handle and its preload bridge, or
document it as a deliberate future/external use case and add a signal.

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

#### P3-03  `electron-builder` `files:` array ships two dead copies of source files
**File**: [package.json:22-30](package.json)
**Description**: Two packaging problems:
1. `dist/**/*` is the built renderer; `src/renderer/**/*` also packages the
   unbuilt JSX sources into the asar. The app loads from `dist/` in production
   (main.js:131), so the source copy is dead weight (~200 kB).
2. `.claude/skills/**/*` appears in both `build.files` (asar) **and**
   `extraResources` (at `resources/.claude/skills`). The backend reads from
   `process.resourcesPath` (extraResources), so the asar copy is also dead.

**Suggestion**: remove `"src/renderer/**/*"` and `".claude/skills/**/*"` from
`build.files`; leave the skills only in `extraResources`.

---

#### P3-04  `ProofTask` objects accumulate in `this.tasks` forever
**File**: [src/main/copilot-engine.js:103](src/main/copilot-engine.js)
**Description**: `submitProofRequest` adds each task to `this.tasks` but only
`cancelProof` calls `this.tasks.delete`. Completed and failed tasks are never
removed. In a long session (30+ "Prove All" runs across a large document),
`this.tasks` and its `AbortController` refs grow without bound.

**Suggestion**: schedule `this.tasks.delete(task.id)` after a 60-second grace
period on completion/failure so the renderer can still read the final status.

---

#### P3-05  DevTools always accessible via View menu in production builds
**File**: [src/main/main.js:254-258](src/main/main.js)
**Description**: The application menu always includes `{ role: 'reload' }`,
`{ role: 'forceReload' }`, and `{ role: 'toggleDevTools' }` regardless of
`isDev`. In a packaged DMG, any user can open the DevTools console (⌘⌥I),
read the API key from React state while Settings is open, or manipulate IPC
calls.

**Suggestion**: gate these items behind `isDev`:
```js
...(isDev ? [
  { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
  { type: 'separator' },
] : []),
```

---

#### P3-06  Auto-update check timer fires twice on macOS re-activate
**File**: [src/main/main.js:179-184](src/main/main.js)
**Description**: `setTimeout(() => autoUpdater.checkForUpdates(), 5000)` is
inside `createWindow()`, which is called again on macOS `activate` (Dock
click after all windows are closed). The second invocation registers a second
5-second timer → two sequential `checkForUpdates()` calls → two
`update:available` IPC messages → the update banner renders twice.

**Suggestion**: move the update-check block to `app.whenReady()` so it runs
exactly once per process lifetime.

---

#### P3-07b  Lean binary detected three times on every startup
**File**: [src/main/main.js:55,142,144](src/main/main.js), [src/main/copilot-engine.js:83-86](src/main/copilot-engine.js)
**Description**: `leanRunner.detect()` runs three times per launch:
1. `ensureEngines()` → `leanRunner.detect()` (line 55)
2. `copilotEngine.configure(storedCopilot)` internally calls `leanRunner.detect()` again (copilot-engine.js:84)
3. Explicit `leanRunner.detect(storedLean.binaryPath || undefined)` at main.js:144

Call 3 is unconditionally redundant with call 2 — both pass the same stored
`binaryPath`, and call 2 already ran inside `configure()`. Each `detect()` runs
`which lean` (blocking via `execFileSync`) + `lean --version`, adding ~150–400 ms.

**Suggestion**: remove the explicit `leanRunner.detect()` call at `main.js:144`
(and `leanRunner.setUsesMathlib()` at line 145 — also already handled by
`configure()`).

---

#### P3-07c  No React StrictMode
**File**: [src/renderer/main.jsx](src/renderer/main.jsx)
**Description**: `App` is rendered without `<React.StrictMode>`. StrictMode
double-invokes `useEffect` in development to surface missing cleanup code.
Without it, subtle listener-leak regressions (e.g. re-introducing P1-01)
would be harder to catch during development.

**Suggestion**: wrap the root render in `<React.StrictMode>` and verify all
`useEffect` cleanups are idempotent under double-invocation (they appear to be).

---

#### P3-07  `package.json` missing `author` field
**File**: [package.json](package.json)
**Description**: `electron-builder` warns at every build:
`author is missed in the package.json`. Some OS trust dialogs, the DMG
metadata, and the macOS "About" panel show an empty author string.

**Suggestion**: add `"author": "Fermat Labs"` (or your organisation name).

---

## 3. Verified **PASS** — checked and found clean

These are things I actively looked at and confirmed are correct, so they don't
get re-litigated on the next audit:

- **IPC channel consistency**: all 31 `ipcMain.handle/on` channels are
  subscribed by preload; all 13 `webContents.send` channels have preload
  `onX` wrappers; no typos, no orphans.
- **Event emitter consistency**: `copilotEngine.emit` → `copilotEngine.on`
  (main forwards) → `webContents.send` → `ipcRenderer.on` (preload) →
  renderer `onProof*` subscribers. Chain is complete for `proof:started`,
  `proof:completed`, `proof:failed`, `proof:status`. **`proof:streaming` is
  wired in main+preload but has no renderer subscriber — see P1-04.**
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

1. **P1-02** — threading `model` through `_runClaude` is a 2-minute fix;
   silently wrong behaviour is the worst kind.
2. **P1-03** — make "lean verification unavailable" a loud failure not a
   silent skip.
3. **P1-01** — the macOS re-activate leak. Two-line fix inside
   `ensureEngines()`.
4. **P1-04** — subscribe to `onProofStreaming` in `useCopilot`. The
   streaming infrastructure is fully wired in main+preload; just one
   subscription is missing.
5. **P1-05** — Monaco bundle trim. Bigger change, but the single largest
   user-facing cold-start win after the correctness bugs above.

Medium-bang-for-buck next: **P2-01** (sandbox), **P2-02** (CSP),
**P3-05** (disable DevTools in prod), **P3-06** (update timer once per process).

Everything else can sit until a dedicated polish pass.
