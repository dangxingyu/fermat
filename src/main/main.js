const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { FermatEngine } = require('./copilot-engine');
const { TexCompiler } = require('./tex-compiler');
const { SynctexBridge } = require('./synctex-bridge');

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
let copilotEngine;
let texCompiler;
let synctexBridge;

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
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Fermat',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // Initialize engines
  copilotEngine = new FermatEngine();
  texCompiler = new TexCompiler();
  synctexBridge = new SynctexBridge();

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

  // Forward copilot events to renderer
  copilotEngine.on('proof:started', (data) => {
    mainWindow.webContents.send('copilot:proof-started', data);
  });
  copilotEngine.on('proof:completed', (data) => {
    mainWindow.webContents.send('copilot:proof-completed', data);
  });
  copilotEngine.on('proof:failed', (data) => {
    mainWindow.webContents.send('copilot:proof-failed', data);
  });
  copilotEngine.on('proof:streaming', (data) => {
    mainWindow.webContents.send('copilot:proof-streaming', data);
  });
  copilotEngine.on('proof:status', (data) => {
    mainWindow.webContents.send('copilot:proof-status', data);
  });
}

// ─── File Operations ───────────────────────────────────────────────
ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'LaTeX Files', extensions: ['tex', 'sty', 'cls', 'bib'] }],
    properties: ['openFile'],
  });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, 'utf-8');
  return { filePath, content };
});

ipcMain.handle('file:save', async (_event, { filePath, content }) => {
  if (!filePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'LaTeX Files', extensions: ['tex'] }],
    });
    if (result.canceled) return null;
    filePath = result.filePath;
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
});

ipcMain.handle('file:read', async (_event, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

// Open a folder: returns { folderPath, files: [...tex/bib files] }
ipcMain.handle('file:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  const folderPath = result.filePaths[0];
  const files = listLatexFiles(folderPath);
  return { folderPath, files };
});

// List .tex / .bib / .sty files in a folder (non-recursive, skips hidden + build dirs).
ipcMain.handle('file:list-dir', async (_event, folderPath) => {
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
});

ipcMain.handle('tex:get-engine', async () => {
  return texCompiler.engine;
});

// ─── Fermat Copilot ────────────────────────────────────────────────
ipcMain.handle('copilot:configure', async (_event, config) => {
  copilotEngine.configure(config);
  // Log whether an API key was provided (masked) so users can verify config.
  const claudeKey = config?.models?.claude?.apiKey;
  if (claudeKey) {
    const masked = claudeKey.slice(0, 10) + '...' + claudeKey.slice(-4);
    console.log(`[Copilot] Configured with Claude API key: ${masked} (model: ${config?.models?.claude?.model})`);
  } else {
    console.log('[Copilot] Configured WITHOUT Claude API key — will rely on Claude CLI if installed');
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

// ─── Log buffer (for late subscribers) ────────────────────────────
ipcMain.handle('log:get-buffer', async () => logBuffer.slice());
ipcMain.handle('log:clear', async () => { logBuffer.length = 0; });

// ─── App Lifecycle ─────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
