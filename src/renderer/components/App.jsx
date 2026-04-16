import React, { useState, useCallback, useEffect, useRef } from 'react';
import Toolbar from './Toolbar';
import TheoryOutline from './TheoryOutline';
import TexEditor from './TexEditor';
import PdfViewer from './PdfViewer';
import LeanPanel from './LeanPanel';
import ProofReviewPanel from './ProofReviewPanel';
import SettingsModal from './SettingsModal';
import LogPanel from './LogPanel';
import { useCopilot } from '../hooks/useCopilot';
import { useOutline } from '../hooks/useOutline';

// ─── Proof-error toast component ────────────────────────────────────────────
// Shown when the AI backend returns a structured error (auth, rate-limit, etc.)
// instead of letting ErrorBoundary swallow it silently.
function ProofErrorToast({ error, onDismiss, onOpenSettings }) {
  const isAuthIssue = error.code === 'AUTH_ERROR' || error.code === 'NO_API_KEY';
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-strong)',
      borderLeft: '2px solid var(--vermillion)',
      borderRadius: 3,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      boxShadow: 'var(--shadow-md)',
      animation: 'card-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{
          fontFamily: 'var(--font-display)',
          fontStyle: 'italic',
          color: 'var(--vermillion)',
          fontSize: 15,
          lineHeight: 1.35,
          flex: 1,
          fontWeight: 500,
        }}>
          {error.userMessage}
        </span>
        <button
          onClick={onDismiss}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 14, lineHeight: 1,
            padding: '0 2px', flexShrink: 0,
          }}
          aria-label="Dismiss"
        >{'\u00D7'}</button>
      </div>
      {error.marker?.label && (
        <div style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
        }}>
          {error.marker.label}
        </div>
      )}
      {isAuthIssue && (
        <button
          onClick={onOpenSettings}
          style={{
            alignSelf: 'flex-start',
            background: 'transparent',
            color: 'var(--accent)',
            border: '1px solid var(--accent-soft)',
            borderRadius: 3,
            padding: '4px 12px',
            fontSize: 11,
            cursor: 'pointer',
            fontWeight: 500,
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
            letterSpacing: '0.02em',
            transition: 'all 0.18s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--accent-soft)';
            e.currentTarget.style.color = 'var(--bg-ink)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--accent)';
          }}
        >Open Settings</button>
      )}
    </div>
  );
}

const SAMPLE_TEX = `\\documentclass{article}
\\usepackage{amsmath, amssymb, amsthm}

\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{lemma}[theorem]{Lemma}
\\newtheorem{proposition}[theorem]{Proposition}
\\newtheorem{corollary}[theorem]{Corollary}
\\theoremstyle{definition}
\\newtheorem{definition}[theorem]{Definition}

\\title{Sample Theory Document}
\\author{Fermat}

\\begin{document}
\\maketitle

\\section{Foundations}

\\begin{definition}[Prime Number]
\\label{def:prime}
A natural number $p > 1$ is \\emph{prime} if its only positive divisors are $1$ and $p$.
\\end{definition}

\\begin{theorem}[Infinitude of Primes]
\\label{thm:inf-primes}
There are infinitely many prime numbers.
\\end{theorem}
% [PROVE IT: Easy]

\\begin{lemma}[Division Lemma]
\\label{lem:division}
For any integers $a$ and $b > 0$, there exist unique integers $q$ and $r$
such that $a = bq + r$ and $0 \\leq r < b$.
\\end{lemma}
% [PROVE IT: Medium]

\\section{Main Results}

\\begin{theorem}[Fundamental Theorem of Arithmetic]
\\label{thm:fta}
Every integer $n > 1$ can be written uniquely as a product of prime numbers,
up to the order of factors. This relies on Lemma~\\ref{lem:division}
and the definition of primes (Definition~\\ref{def:prime}).
\\end{theorem}
% [PROVE IT: Hard]
% SKETCH: Two parts. (1) Existence: strong induction on n; if n is prime
%   we are done, else n = ab with 1 < a, b < n and apply IH to each factor.
%   (2) Uniqueness: suppose n = p_1...p_k = q_1...q_l; use Euclid's lemma
%   (which follows from the division lemma) to show p_1 must equal some q_j,
%   then cancel and induct on k.

\\begin{corollary}
\\label{cor:sqrt2}
$\\sqrt{2}$ is irrational. This follows from Theorem~\\ref{thm:fta}.
\\end{corollary}
% [PROVE IT: Medium]

\\end{document}`;

export default function App() {
  const [content, setContent] = useState(SAMPLE_TEX);
  const [isDirty, setIsDirty] = useState(false);
  const [filePath, setFilePath] = useState(null);
  const [folderPath, setFolderPath] = useState(null);
  const [folderFiles, setFolderFiles] = useState([]); // [{ name, path }]
  const [showSettings, setShowSettings] = useState(false);
  const [showOutline, setShowOutline] = useState(true);
  const [showPdf, setShowPdf] = useState(true);
  const [showReviewPanel, setShowReviewPanel] = useState(true);
  const [showLog, setShowLog] = useState(false);
  // U-02: loading state while opening a file / folder — disables file menu
  // actions and lets the UI show a spinner instead of appearing frozen.
  const [fileLoading, setFileLoading] = useState(false);
  const editorRef = useRef(null);
  const editorAreaRef = useRef(null);
  // Bridges ordering: useCopilot needs the callback; it's defined below.
  const handleAutoInlineRef = useRef(null);

  // ─── Editor content change — marks document dirty ───────────────────
  const handleContentChange = useCallback((newContent) => {
    setContent(newContent);
    setIsDirty(true);
  }, []);

  // ─── Confirm before discarding unsaved changes ───────────────────────
  // U-03: use the main-process native dialog via IPC so we don't block the
  // renderer's event loop with window.confirm(). Falls back to window.confirm
  // in the unlikely case the IPC bridge isn't wired (e.g. dev refresh).
  const confirmDiscard = useCallback(async () => {
    if (!isDirty) return true;
    if (window.api?.window?.confirmDiscard) {
      return await window.api.window.confirmDiscard();
    }
    return window.confirm('You have unsaved changes. Discard them and continue?');
  }, [isDirty]);

  // ─── Resizable split pane (editor ↔ PDF) ───
  const [editorFlex, setEditorFlex] = useState(50); // percentage for editor
  const draggingRef = useRef(false);

  const handleResizerMouseDown = useCallback((e) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev) => {
      if (!draggingRef.current || !editorAreaRef.current) return;
      const rect = editorAreaRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setEditorFlex(Math.min(85, Math.max(15, pct)));
    };
    const onMouseUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // ─── Resizable outline sidebar ───
  const [outlineWidth, setOutlineWidth] = useState(280); // px
  const mainContentRef = useRef(null);
  const outlineDraggingRef = useRef(false);

  const handleOutlineResizerMouseDown = useCallback((e) => {
    e.preventDefault();
    outlineDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev) => {
      if (!outlineDraggingRef.current || !mainContentRef.current) return;
      const rect = mainContentRef.current.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      setOutlineWidth(Math.min(500, Math.max(140, px)));
    };
    const onMouseUp = () => {
      outlineDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // SyncTeX state
  const synctexRef = useRef(null); // { synctexPath, texPath }
  const [forwardHighlight, setForwardHighlight] = useState(null);

  // ─── Right-panel tab: 'pdf' | 'lean' ─────────────────────────────────────
  const [rightTab, setRightTab] = useState('pdf');

  // ─── Lean verification state ──────────────────────────────────────────────
  // Accumulates output lines live; reset when a new proof task starts lean phase.
  const [leanState, setLeanState] = useState(null);
  const leanOutputLinesRef = useRef([]);

  // ─── Auto-update state ────────────────────────────────────────────
  // 'idle' | 'available' | 'downloading' | 'ready'
  const [updateState, setUpdateState] = useState({ phase: 'idle', version: null, percent: null });

  useEffect(() => {
    if (!window.api?.updater) return;
    const offAvailable = window.api.updater.onAvailable(({ version }) => {
      setUpdateState({ phase: 'available', version, percent: null });
    });
    const offProgress = window.api.updater.onDownloadProgress(({ percent }) => {
      setUpdateState(prev => ({ ...prev, phase: 'downloading', percent }));
    });
    const offDownloaded = window.api.updater.onDownloaded(({ version }) => {
      setUpdateState({ phase: 'ready', version, percent: null });
    });
    return () => { offAvailable?.(); offProgress?.(); offDownloaded?.(); };
  }, []);

  const { outline, refreshOutline } = useOutline(content);
  const {
    proofTasks,
    pendingReviews,
    submitMarker,
    acceptProof,
    rejectProof,
    copilotStatus,
    proofErrors,
    dismissError,
  } = useCopilot({
    onAutoInline: (data) => handleAutoInlineRef.current?.(data),
  });

  // Refresh outline when content changes (debounced)
  // Also keep the copilot backend's content in sync
  useEffect(() => {
    const timer = setTimeout(() => {
      refreshOutline();
      window.api?.copilot?.updateContent(content);
    }, 500);
    return () => clearTimeout(timer);
  }, [content, refreshOutline]);

  const handleOpen = useCallback(async () => {
    if (!window.api) return;
    if (!(await confirmDiscard())) return;
    setFileLoading(true);
    try {
      const result = await window.api.file.open();
      if (result) {
        setContent(result.content);
        setFilePath(result.filePath);
        setIsDirty(false);
      }
    } finally {
      setFileLoading(false);
    }
  }, [confirmDiscard]);

  const handleOpenFolder = useCallback(async () => {
    if (!window.api) return;
    if (!(await confirmDiscard())) return;
    setFileLoading(true);
    try {
      const result = await window.api.file.openFolder();
      if (!result) return;
      setFolderPath(result.folderPath);
      setFolderFiles(result.files || []);
      // Auto-open main.tex or the first .tex file if present
      const firstTex = (result.files || []).find(f => /\.tex$/i.test(f.name));
      if (firstTex) {
        const fileContent = await window.api.file.read(firstTex.path);
        setContent(fileContent);
        setFilePath(firstTex.path);
        setIsDirty(false);
      }
    } finally {
      setFileLoading(false);
    }
  }, [confirmDiscard]);

  const handleSelectFile = useCallback(async (file) => {
    if (!window.api) return;
    if (!(await confirmDiscard())) return;
    setFileLoading(true);
    try {
      const fileContent = await window.api.file.read(file.path);
      setContent(fileContent);
      setFilePath(file.path);
      setIsDirty(false);
    } finally {
      setFileLoading(false);
    }
  }, [confirmDiscard]);

  const handleSave = useCallback(async () => {
    if (!window.api) return null;
    const savedPath = await window.api.file.save({ filePath, content });
    if (savedPath) {
      setFilePath(savedPath);
      setIsDirty(false);
    }
    return savedPath;
  }, [filePath, content]);

  const handleSaveAs = useCallback(async () => {
    if (!window.api) return null;
    const savedPath = await window.api.file.saveAs({ filePath, content });
    if (savedPath) {
      setFilePath(savedPath);
      setIsDirty(false);
    }
    return savedPath;
  }, [filePath, content]);

  const handleNew = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    setContent('');
    setFilePath(null);
    setFolderPath(null);
    setFolderFiles([]);
    setIsDirty(false);
  }, [confirmDiscard]);

  const handleCompile = useCallback(async () => {
    if (!window.api) return;
    const result = await window.api.tex.compile({ filePath, content });
    // Store synctex info for forward/inverse search
    if (result?.synctexPath) {
      synctexRef.current = { synctexPath: result.synctexPath, texPath: result.texPath };
    }
    return result;
  }, [filePath, content]);

  // ─── SyncTeX: inverse search (PDF click → editor) ───
  const handleInverseSearch = useCallback(({ line, column }) => {
    if (editorRef.current && line) {
      editorRef.current.revealLineInCenter(line);
      editorRef.current.setPosition({ lineNumber: line, column: (column || 0) + 1 });
      editorRef.current.focus();
    }
  }, []);

  // ─── SyncTeX: forward search (editor → PDF) ───
  const handleForwardSearch = useCallback(async () => {
    if (!window.api?.synctex || !synctexRef.current || !editorRef.current) return;

    const position = editorRef.current.getPosition();
    if (!position) return;

    try {
      const result = await window.api.synctex.forward({
        synctexPath: synctexRef.current.synctexPath,
        texPath: synctexRef.current.texPath,
        line: position.lineNumber,
      });

      if (result) {
        // Trigger a new highlight object (new reference forces useEffect)
        setForwardHighlight({ ...result, _ts: Date.now() });
      }
    } catch (err) {
      console.error('[SyncTeX] Forward search failed:', err);
    }
  }, []);

  const handleOutlineClick = useCallback((node) => {
    if (editorRef.current && node.lineNumber) {
      editorRef.current.revealLineInCenter(node.lineNumber);
      editorRef.current.setPosition({ lineNumber: node.lineNumber, column: 1 });
      editorRef.current.focus();
    }
  }, []);

  const handleSubmitAllMarkers = useCallback(() => {
    if (!outline?.nodes) return;
    for (const node of outline.nodes) {
      if (node.proveItMarker && !node.hasProof) {
        submitMarker({
          id: node.id,
          difficulty: node.proveItMarker.difficulty,
          label: `${node.type}: ${node.name}`,
          lineNumber: node.lineNumber,
          preferredModel: node.proveItMarker.preferredModel,
          fullContent: content,  // pass full doc — backend assembles context
        });
      }
    }
  }, [outline, content, submitMarker]);

  // Replace the `% [PROVE IT: ...]` line for a marker with an actual proof.
  // Also strips any subsequent `% SKETCH:` continuation lines so the user's
  // hint comments don't linger below the inserted proof. Uses functional
  // setContent so it works correctly from IPC callbacks (no stale closure).
  //
  // U-05: search outward from the stored lineNumber in both directions
  // (±200 lines, then full-scan fallback) so proofs still land correctly
  // when the user has edited the document between submit and completion.
  const insertProofAtMarker = useCallback((marker, proof) => {
    if (!marker || !proof) return;
    const lineNum = marker.lineNumber;
    setContent(prev => {
      const lines = prev.split('\n');
      const tryReplaceAt = (i) => {
        if (i < 0 || i >= lines.length) return false;
        if (!lines[i]?.includes('[PROVE IT:')) return false;
        lines[i] = proof;
        let j = i + 1;
        while (j < lines.length && /^\s*%\s*(SKETCH:|\s{2,})/.test(lines[j])) j++;
        if (j > i + 1) lines.splice(i + 1, j - (i + 1));
        return true;
      };

      // Pass 1: expanding search centred on the stored line (±200)
      for (let d = 0; d <= 200; d++) {
        if (tryReplaceAt((lineNum - 1) + d)) return lines.join('\n');
        if (d > 0 && tryReplaceAt((lineNum - 1) - d)) return lines.join('\n');
      }

      // Pass 2: full-document scan as a last resort — prefer the marker that
      // matches the stored difficulty label if we have one.
      const wantedDiff = marker.difficulty;
      let fallbackIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('[PROVE IT:')) continue;
        if (wantedDiff && lines[i].includes(wantedDiff)) { fallbackIdx = i; break; }
        if (fallbackIdx < 0) fallbackIdx = i;
      }
      if (fallbackIdx >= 0 && tryReplaceAt(fallbackIdx)) return lines.join('\n');

      console.warn(`[insertProofAtMarker] No [PROVE IT:] marker found for "${marker.label}" (stored line ${lineNum})`);
      return prev;
    });
  }, []);

  // Auto-inline handler for Easy proofs: insert into editor the moment the
  // task completes, without going through the review queue.
  const handleAutoInline = useCallback((data) => {
    console.log('[Fermat] Auto-inlining proof for', data.marker?.label || data.marker?.id);
    insertProofAtMarker(data.marker, data.proof);
    // Also record in proof memory
    const node = outline?.nodes?.find(n => n.id === data.marker?.id);
    if (node && window.api?.copilot) {
      window.api.copilot.acceptProof({
        label: node.labels?.[0] || node.id,
        statementTeX: node.statementTeX || '',
        proofTeX: data.proof,
      });
    }
  }, [insertProofAtMarker, outline]);

  // Keep the ref in sync so useCopilot's IPC listener always sees latest.
  useEffect(() => { handleAutoInlineRef.current = handleAutoInline; }, [handleAutoInline]);

  // ─── Window title: "filename — Fermat" with "•" prefix when dirty ───
  useEffect(() => {
    const name = filePath ? filePath.split('/').pop() : 'Untitled';
    document.title = isDirty ? `• ${name} — Fermat` : `${name} — Fermat`;
  }, [filePath, isDirty]);

  // ─── Keep main process informed of dirty state ───────────────────────
  // Main's close handler reads this to decide whether to prompt for save.
  useEffect(() => {
    window.api?.window?.setDirty(isDirty);
  }, [isDirty]);

  // ─── Refs for menu-event handlers (avoids stale closures in one-time listener setup) ───
  const handleNewRef = useRef(null);
  const handleOpenRef = useRef(null);
  const handleOpenFolderRef = useRef(null);
  const handleSaveRef = useRef(null);
  const handleSaveAsRef = useRef(null);
  useEffect(() => { handleNewRef.current = handleNew; }, [handleNew]);
  useEffect(() => { handleOpenRef.current = handleOpen; }, [handleOpen]);
  useEffect(() => { handleOpenFolderRef.current = handleOpenFolder; }, [handleOpenFolder]);
  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);
  useEffect(() => { handleSaveAsRef.current = handleSaveAs; }, [handleSaveAs]);

  // ─── Subscribe to Electron menu commands (registered once on mount) ──
  // Allows Cmd+N/O/S/Shift+S to work regardless of where keyboard focus is.
  useEffect(() => {
    if (!window.api?.window) return;
    const offs = [
      window.api.window.onMenuNew(() => handleNewRef.current?.()),
      window.api.window.onMenuOpen(() => handleOpenRef.current?.()),
      window.api.window.onMenuOpenFolder(() => handleOpenFolderRef.current?.()),
      window.api.window.onMenuSave(() => handleSaveRef.current?.()),
      window.api.window.onMenuSaveAs(() => handleSaveAsRef.current?.()),
      window.api.window.onMenuSaveAndClose(async () => {
        const saved = await handleSaveRef.current?.();
        // If save succeeded (or was dismissed), force-close the window.
        // If the user cancelled the save dialog, leave the window open.
        if (saved) window.api.window.forceClose();
      }),
    ];
    return () => offs.forEach(off => off?.());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Lean verification event wiring ────────────────────────────────────────
  // Listen to per-line output from lean and to proof:status phase changes.
  useEffect(() => {
    if (!window.api) return;

    // Live lean output lines
    const offOutput = window.api.lean?.onOutput?.((data) => {
      leanOutputLinesRef.current = [...leanOutputLinesRef.current, data.line];
      setLeanState(prev => prev ? { ...prev, outputLines: leanOutputLinesRef.current } : prev);
    });

    // proof:status carries Lean phase transitions
    const offStatus = window.api.copilot.onProofStatus?.((data) => {
      const leanPhases = [
        'lean-sketching', 'lean-sketch-retry', 'lean-sketch-checking', 'lean-sketch-ok',
        'lean-statement-review',
        'lean-filling', 'lean-fill-ok', 'lean-fill-retry', 'lean-fill-failed',
        'lean-verified', 'lean-partial', 'lean-failed',
      ];
      if (!leanPhases.includes(data.phase)) return;

      if (data.phase === 'lean-sketching' && data.attempt === 1) {
        // New lean pass starting — reset output buffer and switch to Lean tab
        leanOutputLinesRef.current = [];
        setRightTab('lean');
      }
      setLeanState(prev => ({
        ...(prev || {}),
        taskId: data.taskId,
        phase: data.phase,
        attempt: data.attempt,
        maxAttempts: data.maxAttempts,
        outputLines: leanOutputLinesRef.current,
        // Statement review fields (only present on lean-statement-review event)
        ...(data.statement !== undefined ? { statement: data.statement } : {}),
        ...(data.sketch    !== undefined ? { sketch:    data.sketch    } : {}),
        // Preserve sorries if provided
        ...(data.sorries   !== undefined ? { sorries:   data.sorries   } : {}),
      }));
    });

    // proof:completed carries final lean results
    const offCompleted = window.api.copilot.onProofCompleted?.((data) => {
      if (data.leanCode !== undefined) {
        setLeanState(prev => ({
          ...(prev || {}),
          taskId: data.taskId,
          label: data.marker?.label || '',
          leanCode: data.leanCode,
          leanVerified: data.leanVerified,
          leanLog: data.leanLog,
          leanErrors: data.leanErrors,
          sorries: data.sorries ?? prev?.sorries ?? null,
          leanStatement: data.leanStatement ?? prev?.leanStatement ?? null,
          outputLines: leanOutputLinesRef.current,
          phase: data.leanVerified ? 'lean-verified'
               : (data.sorries?.some(s => s.status === 'filled')) ? 'lean-partial'
               : 'lean-failed',
        }));
      }
    });

    return () => {
      offOutput?.();
      offStatus?.();
      offCompleted?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Lean statement review controls ────────────────────────────────────────
  const handleConfirmStatement = useCallback((taskId) => {
    window.api?.lean?.confirmStatement?.(taskId);
  }, []);

  const handleEditStatement = useCallback((taskId, newCode) => {
    window.api?.lean?.editStatement?.(taskId, newCode);
  }, []);

  const handleCancelStatement = useCallback((taskId) => {
    window.api?.lean?.cancelStatement?.(taskId);
  }, []);

  const handleAcceptProof = useCallback((taskId, proof) => {
    acceptProof(taskId);
    const task = proofTasks.get(taskId);
    if (!task) return;
    insertProofAtMarker(task.marker, proof);

    // Record accepted proof in memory so future proofs can reference it
    const node = outline?.nodes?.find(n => n.id === task.marker?.id);
    if (node && window.api?.copilot) {
      window.api.copilot.acceptProof({
        label: node.labels?.[0] || node.id,
        statementTeX: node.statementTeX || '',
        proofTeX: proof,
      });
    }
  }, [proofTasks, acceptProof, outline, insertProofAtMarker]);

  return (
    <div className="app-container">
      <Toolbar
        filePath={filePath}
        isDirty={isDirty}
        folderPath={folderPath}
        folderFiles={folderFiles}
        onNew={handleNew}
        onOpen={handleOpen}
        onOpenFolder={handleOpenFolder}
        onSelectFile={handleSelectFile}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onCompile={handleCompile}
        onToggleOutline={() => setShowOutline(!showOutline)}
        onTogglePdf={() => setShowPdf(!showPdf)}
        onToggleReview={() => setShowReviewPanel(!showReviewPanel)}
        onToggleLog={() => setShowLog(!showLog)}
        onSettings={() => setShowSettings(true)}
        onSubmitAll={handleSubmitAllMarkers}
        copilotStatus={copilotStatus}
      />

      <div className="main-content" ref={mainContentRef}>
        {showOutline && (
          <>
            <TheoryOutline
              outline={outline}
              proofTasks={proofTasks}
              onNodeClick={handleOutlineClick}
              style={{ width: outlineWidth, minWidth: 140, maxWidth: 500 }}
            />
            <div className="resizer" onMouseDown={handleOutlineResizerMouseDown} />
          </>
        )}

        <div className="editor-area" ref={editorAreaRef}>
          <div className="editor-panel" style={{ flex: showPdf ? `0 0 ${editorFlex}%` : '1 1 auto' }}>
            <TexEditor
              content={content}
              onChange={handleContentChange}
              editorRef={editorRef}
              proofTasks={proofTasks}
              onForwardSearch={handleForwardSearch}
              onSave={handleSave}
              onCompile={handleCompile}
            />
          </div>

          {showPdf && (
            <>
              <div className="resizer" onMouseDown={handleResizerMouseDown} />
              {/* ── Right panel: PDF / Lean tab switcher ─────────────── */}
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
                {/* Tab bar — only shown when Lean mode is active */}
                {leanState && (
                  <div style={{
                    display: 'flex', gap: 0, background: 'var(--bg-secondary)',
                    borderBottom: '1px solid var(--border)', flexShrink: 0,
                  }}>
                    {['pdf', 'lean'].map(tab => (
                      <button
                        key={tab}
                        onClick={() => setRightTab(tab)}
                        style={{
                          background: 'none', border: 'none', padding: '6px 16px',
                          fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-display)',
                          fontStyle: 'italic',
                          color: rightTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                          borderBottom: rightTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                          marginBottom: -1,
                        }}
                      >
                        {tab === 'pdf' ? 'PDF' : (
                          <>
                            Lean
                            {leanState.leanVerified === true  && <span style={{ marginLeft: 4, color: 'var(--verdigris)' }}>✓</span>}
                            {leanState.leanVerified === false && <span style={{ marginLeft: 4, color: 'var(--vermillion)' }}>✗</span>}
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {/* Panel content */}
                {rightTab === 'pdf' || !leanState
                  ? <PdfViewer
                      onCompile={handleCompile}
                      onInverseSearch={handleInverseSearch}
                      forwardHighlight={forwardHighlight}
                    />
                  : <LeanPanel
                      leanState={leanState}
                      onConfirmStatement={handleConfirmStatement}
                      onEditStatement={handleEditStatement}
                      onCancelStatement={handleCancelStatement}
                    />
                }
              </div>
            </>
          )}
        </div>

        {showReviewPanel && pendingReviews.length > 0 && (
          <ProofReviewPanel
            reviews={pendingReviews}
            onAccept={handleAcceptProof}
            onReject={rejectProof}
          />
        )}
      </div>

      {showLog && <LogPanel onClose={() => setShowLog(false)} height={220} />}

      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}

      {/* ── File loading overlay (U-02) ───────────────────────────────── */}
      {fileLoading && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 10001, pointerEvents: 'auto',
          fontFamily: 'var(--font-display)', fontStyle: 'italic',
          color: 'var(--text-primary)', fontSize: 13,
        }}>
          <div style={{
            padding: '16px 24px', borderRadius: 4,
            background: 'var(--bg-surface)', border: '1px solid var(--border-strong)',
            boxShadow: 'var(--shadow-md)',
          }}>
            Loading…
          </div>
        </div>
      )}

      {/* ── Update notification banner ───────────────────────────────── */}
      {updateState.phase !== 'idle' && (
        <div style={{
          position: 'fixed',
          top: 52,
          right: 16,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-strong)',
          borderLeft: '2px solid var(--accent)',
          borderRadius: 3,
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 12.5,
          fontFamily: 'var(--font-display)',
          fontStyle: 'italic',
          color: 'var(--text-primary)',
          zIndex: 9998,
          boxShadow: 'var(--shadow-md)',
          animation: 'card-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}>
          {updateState.phase === 'available' && <>
            <span>Fermat {updateState.version} is available</span>
            <button
              onClick={() => { setUpdateState(prev => ({ ...prev, phase: 'downloading' })); window.api.updater.download(); }}
              style={{ background: 'var(--accent)', color: 'var(--bg-ink)', border: 'none', borderRadius: 3, padding: '4px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 11, fontFamily: 'var(--font-sans)', fontStyle: 'normal' }}
            >Download</button>
            <button onClick={() => setUpdateState({ phase: 'idle', version: null, percent: null })}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}>{'\u00D7'}</button>
          </>}
          {updateState.phase === 'downloading' && <>
            <span>Downloading update{updateState.percent != null ? ` · ${updateState.percent}%` : '\u2026'}</span>
          </>}
          {updateState.phase === 'ready' && <>
            <span>Fermat {updateState.version} ready to install</span>
            <button
              onClick={() => window.api.updater.install()}
              style={{ background: 'var(--accent)', color: 'var(--bg-ink)', border: 'none', borderRadius: 3, padding: '4px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 11, fontFamily: 'var(--font-sans)', fontStyle: 'normal' }}
            >Restart &amp; Install</button>
            <button onClick={() => setUpdateState({ phase: 'idle', version: null, percent: null })}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}>{'\u00D7'}</button>
          </>}
        </div>
      )}

      {/* ── Proof-error toasts ─────────────────────────────────────── */}
      {proofErrors.length > 0 && (
        <div style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 9999,
          maxWidth: 360,
        }}>
          {proofErrors.map(err => (
            <ProofErrorToast
              key={err.id}
              error={err}
              onDismiss={() => dismissError(err.id)}
              onOpenSettings={() => {
                dismissError(err.id);
                setShowSettings(true);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
