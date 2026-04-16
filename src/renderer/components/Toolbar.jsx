import React, { useState, useRef, useEffect } from 'react';
import Logo from './Logo';

export default function Toolbar({
  filePath,
  isDirty,
  folderPath,
  folderFiles,
  onNew,
  onOpen,
  onOpenFolder,
  onSelectFile,
  onSave,
  onSaveAs,
  onCompile,
  onToggleOutline,
  onTogglePdf,
  onToggleReview,
  onToggleLog,
  onSettings,
  onSubmitAll,
  copilotStatus,
}) {
  const baseName = filePath ? filePath.split('/').pop() : 'Untitled';
  // Show dirty indicator in the file name badge
  const fileName = isDirty ? `• ${baseName}` : baseName;
  const folderName = folderPath ? folderPath.split('/').filter(Boolean).pop() : null;
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!fileMenuOpen) return;
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setFileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [fileMenuOpen]);

  const hasFolderFiles = folderFiles && folderFiles.length > 0;

  return (
    <div className="toolbar">
      <div className="brand" title="Fermat — a theorem-proving LaTeX editor">
        <Logo size={22} />
        <span className="brand-name">Fermat</span>
      </div>
      <button onClick={onNew} title="New file (Cmd+N)">New</button>
      <button onClick={onOpen} title="Open file (Cmd+O)">Open</button>
      <button onClick={onOpenFolder} title="Open folder — lets LaTeX find \\input{...} and graphics from the project directory">
        Open Folder
      </button>
      <button onClick={onSave} title="Save file (Cmd+S)">Save</button>
      <button onClick={onSaveAs} title="Save As… (Cmd+Shift+S)">Save As</button>
      <button onClick={onCompile} title="Compile LaTeX (Cmd+B)">Compile</button>

      {hasFolderFiles ? (
        <div ref={menuRef} style={{ position: 'relative', display: 'inline-block', WebkitAppRegion: 'no-drag' }}>
          <button
            onClick={() => setFileMenuOpen(!fileMenuOpen)}
            className="file-name"
            title={folderPath}
            style={{
              cursor: 'pointer',
              maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {folderName ? <span style={{ color: 'var(--text-faint)' }}>{folderName}/</span> : ''}
            {fileName}
            <span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{'\u25BE'}</span>
          </button>
          {fileMenuOpen && (
            <div
              style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 4,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-strong)',
                borderRadius: 4, minWidth: 220, maxHeight: 320, overflow: 'auto',
                zIndex: 1000, boxShadow: 'var(--shadow-md)',
                padding: '4px 0',
              }}
            >
              {folderFiles.map((f) => {
                const active = f.path === filePath;
                return (
                  <div
                    key={f.path}
                    onClick={() => { onSelectFile(f); setFileMenuOpen(false); }}
                    style={{
                      padding: '6px 12px', fontSize: 12, cursor: 'pointer',
                      fontFamily: 'var(--font-mono)',
                      color: active ? 'var(--accent)' : 'var(--text-secondary)',
                      background: active ? 'var(--bg-hover)' : 'transparent',
                      borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {f.name}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <span className="file-name">{fileName}</span>
      )}

      <div className="spacer" />

      <button onClick={onSubmitAll} title="Submit all [PROVE IT] markers to AI">
        Prove All
      </button>
      <button onClick={onToggleOutline}>Outline</button>
      <button onClick={onTogglePdf}>PDF</button>
      <button onClick={onToggleReview}>Reviews</button>
      <button onClick={onToggleLog} title="Show backend log (compile output, Claude CLI calls, errors)">Log</button>
      <button onClick={onSettings}>Settings</button>

      <div className="copilot-status">
        <span
          style={{
            width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
            background: copilotStatus.running > 0 ? 'var(--accent)' : 'var(--verdigris)',
            boxShadow: copilotStatus.running > 0
              ? '0 0 0 3px rgba(212, 165, 116, 0.18)'
              : '0 0 0 3px rgba(126, 160, 142, 0.15)',
            animation: copilotStatus.running > 0 ? 'mark-pulse 1.6s ease-in-out infinite' : 'none',
          }}
        />
        {copilotStatus.running > 0
          ? `${copilotStatus.running} proving${'\u2026'}`
          : 'ready'}
      </div>
    </div>
  );
}
