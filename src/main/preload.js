const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // File operations
  file: {
    open: () => ipcRenderer.invoke('file:open'),
    openFolder: () => ipcRenderer.invoke('file:open-folder'),
    listDir: (folderPath) => ipcRenderer.invoke('file:list-dir', folderPath),
    save: (data) => ipcRenderer.invoke('file:save', data),
    saveAs: (data) => ipcRenderer.invoke('file:save-as', data),
    read: (filePath) => ipcRenderer.invoke('file:read', filePath),
  },

  // Window helpers — dirty state, title, menu-event listeners
  window: {
    // Tell main process whether the document has unsaved changes.
    setDirty: (dirty) => ipcRenderer.send('window:set-dirty', dirty),
    // Skip the dirty check and destroy the window (used after "save and close").
    forceClose: () => ipcRenderer.send('window:force-close'),
    // Subscribe to menu-triggered file commands.
    onMenuNew:         (cb) => { const h = () => cb(); ipcRenderer.on('menu:new',           h); return () => ipcRenderer.removeListener('menu:new',           h); },
    onMenuOpen:        (cb) => { const h = () => cb(); ipcRenderer.on('menu:open',          h); return () => ipcRenderer.removeListener('menu:open',          h); },
    onMenuOpenFolder:  (cb) => { const h = () => cb(); ipcRenderer.on('menu:open-folder',   h); return () => ipcRenderer.removeListener('menu:open-folder',   h); },
    onMenuSave:        (cb) => { const h = () => cb(); ipcRenderer.on('menu:save',          h); return () => ipcRenderer.removeListener('menu:save',          h); },
    onMenuSaveAs:      (cb) => { const h = () => cb(); ipcRenderer.on('menu:save-as',       h); return () => ipcRenderer.removeListener('menu:save-as',       h); },
    onMenuSaveAndClose:(cb) => { const h = () => cb(); ipcRenderer.on('menu:save-and-close',h); return () => ipcRenderer.removeListener('menu:save-and-close',h); },
  },

  // TeX compilation
  tex: {
    compile: (data) => ipcRenderer.invoke('tex:compile', data),
    setEngine: (engine) => ipcRenderer.invoke('tex:set-engine', engine),
    getEngine: () => ipcRenderer.invoke('tex:get-engine'),
  },

  // Fermat Copilot
  copilot: {
    configure: (config) => ipcRenderer.invoke('copilot:configure', config),
    submitProof: (marker) => ipcRenderer.invoke('copilot:submit-proof', marker),
    cancelProof: (markerId) => ipcRenderer.invoke('copilot:cancel-proof', markerId),
    getStatus: () => ipcRenderer.invoke('copilot:get-status'),
    updateContent: (content) => ipcRenderer.invoke('copilot:update-content', content),
    acceptProof: (data) => ipcRenderer.invoke('copilot:accept-proof', data),
    onProofStarted: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('copilot:proof-started', handler);
      return () => ipcRenderer.removeListener('copilot:proof-started', handler);
    },
    onProofCompleted: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('copilot:proof-completed', handler);
      return () => ipcRenderer.removeListener('copilot:proof-completed', handler);
    },
    onProofFailed: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('copilot:proof-failed', handler);
      return () => ipcRenderer.removeListener('copilot:proof-failed', handler);
    },
    onProofStreaming: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('copilot:proof-streaming', handler);
      return () => ipcRenderer.removeListener('copilot:proof-streaming', handler);
    },
    onProofStatus: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('copilot:proof-status', handler);
      return () => ipcRenderer.removeListener('copilot:proof-status', handler);
    },
  },

  // Lean 4 verification
  lean: {
    getPath: (overridePath) => ipcRenderer.invoke('lean:get-path', overridePath),
    verify: (data) => ipcRenderer.invoke('lean:verify', data),
    // Statement review controls — resume the pipeline after the user has
    // inspected (and optionally edited) the generated theorem statement.
    confirmStatement: (taskId) => ipcRenderer.invoke('lean:confirm-statement', taskId),
    editStatement: (taskId, newCode) => ipcRenderer.invoke('lean:edit-statement', { taskId, newCode }),
    cancelStatement: (taskId) => ipcRenderer.invoke('lean:cancel-statement', taskId),
    onOutput: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('lean:output', handler);
      return () => ipcRenderer.removeListener('lean:output', handler);
    },
  },

  // SyncTeX (source ↔ PDF mapping)
  synctex: {
    forward: (data) => ipcRenderer.invoke('synctex:forward', data),
    inverse: (data) => ipcRenderer.invoke('synctex:inverse', data),
  },

  // Outline
  outline: {
    parse: (content) => ipcRenderer.invoke('outline:parse', content),
  },

  // Main-process log stream
  log: {
    getBuffer: () => ipcRenderer.invoke('log:get-buffer'),
    clear: () => ipcRenderer.invoke('log:clear'),
    onEntry: (cb) => {
      const handler = (_e, entry) => cb(entry);
      ipcRenderer.on('log:entry', handler);
      return () => ipcRenderer.removeListener('log:entry', handler);
    },
  },

  // Auto-updater
  updater: {
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onAvailable: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('update:available', handler);
      return () => ipcRenderer.removeListener('update:available', handler);
    },
    onDownloadProgress: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('update:download-progress', handler);
      return () => ipcRenderer.removeListener('update:download-progress', handler);
    },
    onDownloaded: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('update:downloaded', handler);
      return () => ipcRenderer.removeListener('update:downloaded', handler);
    },
  },
});
