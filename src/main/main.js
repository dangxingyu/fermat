const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { FermatEngine } = require('./copilot-engine');
const { TexCompiler } = require('./tex-compiler');
const { SynctexBridge } = require('./synctex-bridge');
const { LeanRunner } = require('./lean-runner');
const { CompletionBackend } = require('./completion-backend');

// ─── Persistent settings store ────────────────────────────────────────────
// Wires into the `copilot:configure`, `tex:set-engine`, and `settings:load` IPC
// handlers so settings survive across app restarts.
const settingsStore = new Store({
  name: 'fermat-settings',
  defaults: {
    copilot: {
      defaultModel: 'claude',
      models: { claude: { apiKey: '', model: 'claude-sonnet-4-6' } },
      maxConcurrent: 3,
      autoInlineDifficulty: ['Easy'],
      verificationMode: 'off',
      lean: { binaryPath: '', maxRetries: 3, usesMathlib: false, useRepl: false },
    },
    texEngine: 'tectonic',
  },
});

// ─── Auto-updater (electron-updater → GitHub Releases) ────────────────────
// Only active in packaged builds; skipped in dev mode so dev startup is fast.
// Fill owner/repo in package.json → build.publish before publishing releases.
let autoUpdater = null;
if (app.isPackaged) {
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = false;        // ask user before downloading
    autoUpdater.autoInstallOnAppQuit = true; // install on next quit if downloaded
    autoUpdater.logger = console;
  } catch (e) {
    console.warn('[AutoUpdater] electron-updater not available:', e.message);
  }
}

let mainWindow;
// Q-03: engines are singletons created at module load, not inside createWindow.
// macOS re-activate (`activate` event) opens a fresh window but keeps these
// alive so queued tasks and accepted-proof memory survive across window churn.
let copilotEngine;
let texCompiler;
let synctexBridge;
let leanRunner;
let completionBackend;

function ensureEngines() {
  if (leanRunner)  return;
  console.log('[Fermat] Initializing engines…');
  leanRunner    = new LeanRunner();
  // detect() is async (spawns child processes). Called after window loads — see
  // createWindow() — so it never blocks the main event loop during startup.
  // Q-02: share one LeanRunner across IPC + the copilot engine
  copilotEngine = new FermatEngine({ leanRunner });
  texCompiler   = new TexCompiler();
  synctexBridge = new SynctexBridge();
  completionBackend = new CompletionBackend();
  console.log('[Fermat] Engines initialized');

  // QA P1-01: attach proof-event forwarders ONCE, not inside createWindow.
  // createWindow used to re-attach these every time, so on macOS each close
  // + dock-reopen cycle multiplied the listener count by 1 and every proof
  // event was sent N times. Listeners below reference `mainWindow` by
  // variable binding, so they always send to whichever window is current.
  const sendToRenderer = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  };
  copilotEngine.on('proof:started',   (d) => sendToRenderer('copilot:proof-started',   d));
  copilotEngine.on('proof:completed', (d) => sendToRenderer('copilot:proof-completed', d));
  copilotEngine.on('proof:failed',    (d) => sendToRenderer('copilot:proof-failed',    d));
  copilotEngine.on('proof:streaming', (d) => sendToRenderer('copilot:proof-streaming', d));
  copilotEngine.on('proof:status',    (d) => sendToRenderer('copilot:proof-status',    d));
}

// Renderer reports its dirty state here so the close handler can decide.
let isDirtyInRenderer = false;

// ─── Log forwarding: tee main-process console output to renderer ───
const logBuffer = []; // keep last N entries so late subscribers can catch up
const MAX_LOG_BUFFER = 500;

function emitLog(level, ...args) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const text = args.map(a =>
    typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
  ).join(' ');
  const entry = { ts, level, text };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log:entry', entry);
  }
}

// Wrap console methods so existing console.log calls throughout main get forwarded.
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
const origWarn = console.warn.bind(console);
console.log = (...args) => { origLog(...args); emitLog('info', ...args); };
console.error = (...args) => { origErr(...args); emitLog('error', ...args); };
console.warn = (...args) => { origWarn(...args); emitLog('warn', ...args); };

const isDev = !app.isPackaged;

function createWindow() {
  console.log(`[Fermat] Creating window (${isDev ? 'dev' : 'prod'})`);
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    // title is managed dynamically by the renderer via document.title
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // ─── Intercept close to check for unsaved changes ───────────────────
  mainWindow.on('close', async (e) => {
    if (!isDirtyInRenderer) return; // no unsaved changes, close normally
    e.preventDefault();
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Save changes before closing?',
      detail: 'Your changes will be lost if you close without saving.',
    });
    if (response === 0) {
      // Tell renderer to save then close — renderer calls window:force-close when done.
      mainWindow.webContents.send('menu:save-and-close');
    } else if (response === 1) {
      isDirtyInRenderer = false;
      mainWindow.destroy();
    }
    // response === 2 (Cancel): do nothing, window stays open
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // Engines are created once (Q-03). On macOS re-activate we reuse them.
  ensureEngines();

  // ─── Restore persisted settings ───────────────────────────────────────
  // Apply stored copilot / tex / lean config before the renderer mounts, so
  // the first proof submission already picks up the saved API key.
  // NOTE: leanRunner.detect() is intentionally excluded here — it's async and
  // can block the event loop for several seconds (elan shim init). Lean binary
  // detection is deferred to after the renderer has loaded (see below).
  try {
    const storedCopilot = settingsStore.get('copilot');
    if (storedCopilot) {
      copilotEngine.configure(storedCopilot);
      const storedLean  = storedCopilot.lean || {};
      const storedModel = storedCopilot.models?.claude?.model || storedCopilot.defaultModel || '(default)';
      leanRunner.setUsesMathlib(!!storedLean.usesMathlib);
      leanRunner.setUseRepl(!!storedLean.useRepl);
      // Fire lean binary detection asynchronously after window is ready.
      mainWindow.webContents.once('did-finish-load', () => {
        leanRunner.detect(storedLean.binaryPath || undefined)
          .then(r => {
            if (r.available) {
              const ver = r.version?.split('\n')[0] ?? 'unknown';
              console.log(`[LeanRunner] Detection complete: ${ver} at ${r.path} | mathlib=${leanRunner.mathlibReady ? 'ready' : 'not found'} | mode=${r.mode}`);
            } else {
              console.warn(`[LeanRunner] Detection complete: lean not found | mathlib=${leanRunner.mathlibReady ? 'ready' : 'not found'}`);
            }
          })
          .catch(err => console.warn('[LeanRunner] Detection error:', err.message));
      });
      console.log(`[Settings] Restored: model=${storedModel} | maxConcurrent=${storedCopilot.maxConcurrent ?? 3} | verifyMode=${storedCopilot.verificationMode ?? 'off'} | lean.mathlib=${!!storedLean.usesMathlib} | lean.repl=${!!storedLean.useRepl}`);
    } else {
      console.log('[Settings] No persisted settings found — using defaults');
    }
    const storedEngine = settingsStore.get('texEngine');
    if (storedEngine) texCompiler.setEngine(storedEngine);
    console.log('[Settings] Settings applied');
  } catch (err) {
    console.warn('[Settings] Failed to restore settings:', err.message);
  }

  // ─── Auto-updater events ───────────────────────────────────────────
  if (autoUpdater) {
    autoUpdater.on('update-available', (info) => {
      console.log(`[AutoUpdater] Update available: ${info.version}`);
      mainWindow.webContents.send('update:available', { version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      console.log('[AutoUpdater] Already up to date.');
    });
    autoUpdater.on('download-progress', (p) => {
      mainWindow.webContents.send('update:download-progress', { percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
      mainWindow.webContents.send('update:downloaded', { version: info.version });
    });
    autoUpdater.on('error', (err) => {
      console.error('[AutoUpdater] Error:', err.message);
    });

    // Only check for updates if a publish config is bundled (app-update.yml).
    // When package.json `build.publish` is null, the file isn't generated and
    // electron-updater throws a noisy ENOENT we'd rather not print.
    const updateYml = path.join(process.resourcesPath, 'app-update.yml');
    if (fs.existsSync(updateYml)) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err =>
          console.warn('[AutoUpdater] Check failed:', err.message)
        );
      }, 5000);
    }
  }

  // ─── Application menu (enables global keyboard shortcuts) ──────────
  const menuTemplate = [
    // macOS: standard app menu (About, Hide, Quit, etc.)
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new'),
        },
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open'),
        },
        {
          label: 'Open Folder…',
          click: () => mainWindow?.webContents.send('menu:open-folder'),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu:save-as'),
        },
        { type: 'separator' },
        // On macOS the Quit item lives in the app menu above; on Windows/Linux add it here.
        ...(process.platform !== 'darwin' ? [{ role: 'quit' }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [{ type: 'separator' }, { role: 'front' }]
          : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // QA P1-01: proof-event forwarders are attached once in ensureEngines().
  // Do NOT re-attach them here — createWindow() runs on every macOS dock
  // re-activate, which would multiply listeners.
}

// ─── File Operations ───────────────────────────────────────────────
ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'LaTeX Files', extensions: ['tex', 'sty', 'cls', 'bib'] }],
    properties: ['openFile'],
  });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  registerApprovedPath(filePath); // S-01: whitelist before renderer can re-read it
  const content = fs.readFileSync(filePath, 'utf-8');
  return { filePath, content };
});

ipcMain.handle('file:save', async (_event, { filePath, content }) => {
  if (!filePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [
        { name: 'LaTeX Files', extensions: ['tex', 'sty', 'cls', 'bib'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return null;
    filePath = result.filePath;
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  registerApprovedPath(filePath); // S-01
  return filePath;
});

// Save As: always shows the dialog regardless of whether a path is already set.
ipcMain.handle('file:save-as', async (_event, { filePath, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filePath || undefined, // pre-fill current name if available
    filters: [
      { name: 'LaTeX Files', extensions: ['tex', 'sty', 'cls', 'bib'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, content, 'utf-8');
  registerApprovedPath(result.filePath); // S-01
  return result.filePath;
});

// ─── Sandbox: approved paths for renderer file reads (S-01 fix) ───
// Any path that the user explicitly exposes (via file:open, file:open-folder,
// file:save, or file:save-as) is registered here. file:read rejects paths
// not in this set, which blocks the renderer from pulling arbitrary files
// like /etc/passwd or ~/.ssh/id_rsa via a compromised script.
const approvedReadPaths = new Set();
const approvedReadDirs  = new Set();

function registerApprovedPath(p) {
  if (!p) return;
  try { approvedReadPaths.add(fs.realpathSync(p)); }
  catch { approvedReadPaths.add(path.resolve(p)); }
}
function registerApprovedDir(d) {
  if (!d) return;
  try { approvedReadDirs.add(fs.realpathSync(d)); }
  catch { approvedReadDirs.add(path.resolve(d)); }
}
function isPathApproved(requested) {
  try {
    const real = fs.existsSync(requested) ? fs.realpathSync(requested) : path.resolve(requested);
    if (approvedReadPaths.has(real)) return true;
    for (const dir of approvedReadDirs) {
      const rel = path.relative(dir, real);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

ipcMain.handle('file:read', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) {
    throw new Error('file:read requires a non-empty path');
  }
  if (!isPathApproved(filePath)) {
    console.warn(`[Security] file:read denied (not approved): ${filePath}`);
    throw new Error(`file:read denied: path not approved (${filePath})`);
  }
  return fs.readFileSync(filePath, 'utf-8');
});

// Open a folder: returns { folderPath, files: [...tex/bib files] }
ipcMain.handle('file:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  const folderPath = result.filePaths[0];
  registerApprovedDir(folderPath); // S-01: allow reads anywhere under this folder
  const files = listLatexFiles(folderPath);
  return { folderPath, files };
});

// List .tex / .bib / .sty files in a folder (non-recursive, skips hidden + build dirs).
// S-01: only list folders the user has explicitly opened via file:open-folder.
ipcMain.handle('file:list-dir', async (_event, folderPath) => {
  if (typeof folderPath !== 'string' || !folderPath) return [];
  if (!isPathApproved(folderPath)) {
    console.warn(`[Security] file:list-dir denied (not approved): ${folderPath}`);
    return [];
  }
  return listLatexFiles(folderPath);
});

function listLatexFiles(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && /\.(tex|bib|sty|cls)$/i.test(e.name))
      .map(e => ({ name: e.name, path: path.join(folderPath, e.name) }))
      .sort((a, b) => {
        // main.tex first, then alphabetical
        if (a.name === 'main.tex') return -1;
        if (b.name === 'main.tex') return 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

// ─── TeX Compilation ───────────────────────────────────────────────
ipcMain.handle('tex:compile', async (_event, { filePath, content }) => {
  return texCompiler.compile(filePath, content);
});

ipcMain.handle('tex:set-engine', async (_event, engine) => {
  texCompiler.setEngine(engine);
  // Persist selection (B-01 fix)
  try { settingsStore.set('texEngine', engine); } catch (err) {
    console.warn('[Settings] Failed to persist tex engine:', err.message);
  }
});

ipcMain.handle('tex:get-engine', async () => {
  return texCompiler.engine;
});

// ─── Fermat Copilot ────────────────────────────────────────────────
ipcMain.handle('copilot:configure', async (_event, config) => {
  copilotEngine.configure(config);
  // Persist to disk so settings survive restarts (B-01 fix)
  try { settingsStore.set('copilot', config); } catch (err) {
    console.warn('[Settings] Failed to persist copilot config:', err.message);
  }
  // Log whether an API key was provided (masked) so users can verify config.
  const claudeKey = config?.models?.claude?.apiKey;
  if (claudeKey) {
    // Require at least 16 chars before showing any prefix/suffix (S-02 fix)
    const masked = claudeKey.length >= 16
      ? claudeKey.slice(0, 6) + '…' + claudeKey.slice(-4)
      : `(key length ${claudeKey.length})`;
    console.log(`[Copilot] Configured with Claude API key: ${masked} (model: ${config?.models?.claude?.model})`);
  } else {
    console.log('[Copilot] Configured WITHOUT Claude API key — will rely on Claude CLI if installed');
  }
  // Re-detect lean binary whenever settings change (user may have updated leanPath).
  // detect() is async — fire and forget; the result is visible via lean:get-path.
  if (config?.lean?.binaryPath !== undefined) {
    leanRunner.detect(config.lean.binaryPath || undefined)
      .catch(err => console.warn('[LeanRunner] Detection error:', err.message));
  }
  if (config?.lean?.usesMathlib !== undefined) {
    leanRunner.setUsesMathlib(!!config.lean.usesMathlib);
  }
  if (config?.lean?.useRepl !== undefined) {
    leanRunner.setUseRepl(!!config.lean.useRepl);
  }
});

ipcMain.handle('copilot:submit-proof', async (_event, marker) => {
  return copilotEngine.submitProofRequest(marker);
});

ipcMain.handle('copilot:cancel-proof', async (_event, markerId) => {
  return copilotEngine.cancelProof(markerId);
});

ipcMain.handle('copilot:get-status', async () => {
  return copilotEngine.getStatus();
});

ipcMain.handle('copilot:update-content', async (_event, content) => {
  copilotEngine.updateContent(content);
});

ipcMain.handle('copilot:accept-proof', async (_event, { label, statementTeX, proofTeX }) => {
  copilotEngine.recordAcceptedProof(label, statementTeX, proofTeX);
});

// ─── SyncTeX (source ↔ PDF mapping) ───────────────────────────────
ipcMain.handle('synctex:forward', async (_event, { synctexPath, texPath, line }) => {
  return synctexBridge.forwardSearch(synctexPath, texPath, line);
});

ipcMain.handle('synctex:inverse', async (_event, { synctexPath, page, x, y }) => {
  return synctexBridge.inverseSearch(synctexPath, page, x, y);
});

// ─── Lean 4 Verification ───────────────────────────────────────────

// Return current lean binary info (available, path, version).
// Pass an optional override path (from settings) to re-detect.
ipcMain.handle('lean:get-path', async (_event, overridePath) => {
  return leanRunner.detect(overridePath || undefined);
});

// Run lean on a Lean 4 source snippet.
// Streams output lines back via 'lean:output' events; returns final result.
ipcMain.handle('lean:verify', async (event, { source, taskId }) => {
  const onLine = (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lean:output', { taskId, line });
    }
  };
  try {
    const result = await leanRunner.verify(source, onLine);
    return { taskId, ...result };
  } catch (err) {
    return { taskId, success: false, errors: [{ line: 0, col: 0, severity: 'error', message: err.message }], rawOutput: '' };
  }
});

// ─── Lean statement review controls ───────────────────────────────
// These IPC handlers let the renderer resume the lean pipeline after the
// user has reviewed (and optionally edited) the generated theorem statement.

ipcMain.handle('lean:confirm-statement', async (_event, taskId) => {
  copilotEngine.confirmLeanStatement(taskId);
});

ipcMain.handle('lean:edit-statement', async (_event, { taskId, newCode }) => {
  copilotEngine.editLeanStatement(taskId, newCode);
});

ipcMain.handle('lean:cancel-statement', async (_event, taskId) => {
  copilotEngine.cancelLeanStatement(taskId);
});

// ─── Inline completion (Cursor-style ghost text) ──────────────────
// The renderer debounces keystrokes ~300ms and then fires `completion:request`.
// We route it through Claude Haiku for low-latency FIM-style completions.
// If a newer request supersedes an older one, the renderer sends
// `completion:cancel` with the stale requestId so we can abort the API call.
ipcMain.handle('completion:request', async (_event, args) => {
  try {
    // Pull API key from the persisted copilot config so completions "just work"
    // once the user has configured their key in Settings (no extra setup needed).
    const copilotCfg = settingsStore.get('copilot') || {};
    const apiKey = copilotCfg?.models?.claude?.apiKey || '';
    return await completionBackend.complete({
      prefix: args?.prefix || '',
      suffix: args?.suffix || '',
      requestId: args?.requestId,
      apiKey,
      model: args?.model, // default = Haiku
    });
  } catch (err) {
    return { error: err?.message || String(err) };
  }
});
ipcMain.handle('completion:cancel', async (_event, requestId) => {
  if (!completionBackend || !requestId) return false;
  return completionBackend.cancel(requestId);
});

// ─── Persistent settings ───────────────────────────────────────────
// Renderer reads this on mount to hydrate the Settings modal with the
// user's saved preferences (B-01 fix — settings no longer reset on restart).
ipcMain.handle('settings:load', async () => {
  return {
    copilot: settingsStore.get('copilot'),
    texEngine: settingsStore.get('texEngine'),
  };
});

// ─── Theory Outline ────────────────────────────────────────────────
ipcMain.handle('outline:parse', async (_event, content) => {
  const { parseTheoryOutline } = require('./outline-parser');
  return parseTheoryOutline(content);
});

// ─── Auto-updater IPC ──────────────────────────────────────────────
ipcMain.handle('update:download', async () => {
  if (autoUpdater) autoUpdater.downloadUpdate();
});
ipcMain.handle('update:install', async () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
});

// ─── Window / dirty-state helpers ─────────────────────────────────
// Renderer reports dirty state whenever it changes so the close handler
// can decide whether to prompt for unsaved changes.
ipcMain.on('window:set-dirty', (_event, dirty) => {
  isDirtyInRenderer = !!dirty;
});

// U-03: async confirmation dialog — replaces window.confirm() which blocks
// the renderer event loop.
ipcMain.handle('window:confirm-discard', async () => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Discard', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'You have unsaved changes.',
    detail: 'Discard them and continue?',
  });
  return response === 0; // true = discard, false = cancel
});

// Renderer calls this after a successful "save and close" sequence to
// bypass the dirty check and actually destroy the window.
ipcMain.on('window:force-close', () => {
  isDirtyInRenderer = false;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
});

// ─── Log buffer (for late subscribers) ────────────────────────────
ipcMain.handle('log:get-buffer', async () => logBuffer.slice());
ipcMain.handle('log:clear', async () => { logBuffer.length = 0; });

// ─── App Lifecycle ─────────────────────────────────────────────────
// Engines need electron's `app.getPath` etc., so we wait for app-ready
// before initialising them — but BEFORE the first window is shown.
app.whenReady().then(() => {
  ensureEngines();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
