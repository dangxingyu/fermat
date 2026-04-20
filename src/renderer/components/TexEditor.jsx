import React, { useEffect, useRef, useState } from 'react';
// QA P1-04: import only the core editor API, not the barrel entry. The
// barrel (`monaco-editor`) side-effect-imports 80+ language contributions
// (abap, freemarker2, systemverilog, …) none of which Fermat uses — the
// LaTeX grammar is registered by hand below. Core-only import shaves the
// main chunk from ~3.79 MB to ~1 MB.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { latexLanguage, latexTheme } from '../utils/latex-language';
import { registerLaTeXCompletions, LATEX_AUTO_PAIRS } from '../utils/latex-completions';
import { registerInlineCompletions } from '../completion-provider';

// ─── Register LaTeX language once at module level ──────────────────
let languageRegistered = false;
let inlineCompletionsRegistered = false;

function ensureLanguageRegistered() {
  if (languageRegistered) return;
  languageRegistered = true;

  monaco.languages.register({ id: 'latex' });
  monaco.languages.setMonarchTokensProvider('latex', latexLanguage);
  monaco.editor.defineTheme('fermat-dark', latexTheme);

  monaco.languages.setLanguageConfiguration('latex', {
    autoClosingPairs: LATEX_AUTO_PAIRS.autoClosingPairs,
    surroundingPairs: LATEX_AUTO_PAIRS.surroundingPairs,
    brackets: LATEX_AUTO_PAIRS.brackets,
    onEnterRules: [
      {
        beforeText: /\\begin\{[^}]*\}\s*$/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
      {
        afterText: /^\\end\{[^}]*\}/,
        action: { indentAction: monaco.languages.IndentAction.None, removeText: 1 },
      },
    ],
    comments: {
      lineComment: '%',
    },
    folding: {
      markers: {
        start: /\\begin\{/,
        end: /\\end\{/,
      },
    },
  });
}

/**
 * Monaco-based LaTeX editor with:
 * - LaTeX syntax highlighting
 * - [PROVE IT: X] marker decorations
 * - Auto-completion, bracket pairing, environment closing
 * - Keyboard shortcuts
 * - VS Code-style model-per-tab: each tab gets its own ITextModel so undo/redo
 *   history is independent per file. App.jsx manages tab state; TexEditor
 *   manages Monaco model lifecycle.
 *
 * Tab model API (exposed on editorRef.current):
 *   _createTabModel(tabId, content)  — create a Monaco model for a new tab
 *   _destroyTabModel(tabId)          — dispose a model when its tab is closed
 *   _setTabContent(tabId, content)   — replace a model's content (file reload)
 */
export default function TexEditor({ content, onChange, editorRef, activeTabId, proofTasks, onForwardSearch, onSave, onCompile }) {
  const containerRef = useRef(null);
  const editorInstanceRef = useRef(null);
  const decorationsRef = useRef([]);
  const [error, setError] = useState(null);

  // Per-tab Monaco models and saved view states (cursor + scroll position).
  const tabModelsRef     = useRef(new Map()); // tabId → ITextModel
  const tabViewStatesRef = useRef(new Map()); // tabId → IViewState

  // Track current activeTabId in a ref so the init effect (which runs once)
  // can register the initial model under the correct tabId.
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  // Bridge latest callbacks into stable refs so Monaco's command handlers
  // (registered once) always see the current React state (filePath etc.).
  const onSaveRef = useRef(onSave);
  const onCompileRef = useRef(onCompile);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  useEffect(() => { onCompileRef.current = onCompile; }, [onCompile]);

  // ─── Initialize editor ───
  useEffect(() => {
    if (!containerRef.current) return;

    try {
      ensureLanguageRegistered();

      const editor = monaco.editor.create(containerRef.current, {
        value: content,
        language: 'latex',
        theme: 'fermat-dark',
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: 14,
        lineHeight: 22,
        minimap: { enabled: false },
        wordWrap: 'on',
        lineNumbers: 'on',
        renderWhitespace: 'none',
        bracketPairColorization: { enabled: true },
        scrollBeyondLastLine: false,
        padding: { top: 10 },
        autoClosingBrackets: 'always',
        autoClosingQuotes: 'always',
        autoSurround: 'languageDefined',
        folding: true,
        foldingStrategy: 'auto',
        suggest: {
          showKeywords: true,
          showSnippets: true,
          snippetsPreventQuickSuggestions: false,
          insertMode: 'replace',
        },
        quickSuggestions: {
          other: true,
          comments: false,
          strings: true,
        },
        snippetSuggestions: 'top',
        tabCompletion: 'on',
        acceptSuggestionOnCommitCharacter: true,
        // Enable Cursor-style ghost-text inline completions. The provider is
        // registered below and talks to Claude Haiku via IPC.
        inlineSuggest: { enabled: true, mode: 'prefix' },
      });

      editorInstanceRef.current = editor;

      // Register the initial Monaco model (created by monaco.editor.create)
      // under the current active tab so we can switch back to it later.
      const initialModel = editor.getModel();
      tabModelsRef.current.set(activeTabIdRef.current, initialModel);

      // ─── Tab model management API ───────────────────────────────────
      // App.jsx calls these before switching activeTabId so the model exists
      // in tabModelsRef by the time the activeTabId useEffect fires.

      editor._createTabModel = (tabId, initialContent) => {
        if (tabModelsRef.current.has(tabId)) return; // already exists
        const model = monaco.editor.createModel(initialContent || '', 'latex');
        tabModelsRef.current.set(tabId, model);
      };

      editor._destroyTabModel = (tabId) => {
        const model = tabModelsRef.current.get(tabId);
        if (model) {
          model.dispose();
          tabModelsRef.current.delete(tabId);
        }
        tabViewStatesRef.current.delete(tabId);
      };

      // Replace a model's content (e.g., file reload into existing tab).
      // Uses model.setValue so the change is tracked in Monaco's undo stack
      // for that model (it does clear the stack, which is expected for a fresh load).
      editor._setTabContent = (tabId, newContent) => {
        const model = tabModelsRef.current.get(tabId);
        if (model) model.setValue(newContent);
      };

      if (editorRef) editorRef.current = editor;

      // Register LaTeX completions
      const completionDisposables = registerLaTeXCompletions(monaco, editor);

      // Register the Claude-powered inline completion provider once per page
      // load. It's a language-level provider, so multiple editor instances
      // share it — that's fine since each invocation gets its own model+pos.
      let inlineDispose = null;
      if (!inlineCompletionsRegistered) {
        inlineCompletionsRegistered = true;
        inlineDispose = registerInlineCompletions(monaco, 'latex');
      }

      // Content change handler — fires only for the active model (editor-level,
      // not model-level, so it follows setModel automatically).
      const contentDisposable = editor.onDidChangeModelContent(() => {
        onChange(editor.getValue());
      });

      // Keyboard shortcuts — delegate to App-level handlers so the current
      // filePath / React state is respected (Cmd+S on an opened file writes
      // back to that file instead of prompting Save As).
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (onSaveRef.current) onSaveRef.current();
        else window.api?.file.save({ filePath: null, content: editor.getValue() });
      });

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => {
        if (onCompileRef.current) onCompileRef.current();
        else window.api?.tex.compile({ filePath: null, content: editor.getValue() });
      });

      // Cmd+' (Cmd+Quote): Forward SyncTeX search — jump to corresponding PDF position
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Quote,
        () => { if (onForwardSearch) onForwardSearch(); }
      );

      // Cmd+K: Insert [PROVE IT: Medium] + SKETCH template after the nearest
      // enclosing/preceding \end{theorem|lemma|...}. Places cursor at the
      // SKETCH line so the user can immediately type their hint.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
        const model = editor.getModel();
        if (!model) return;
        const pos = editor.getPosition();
        if (!pos) return;

        const THEOREM_ENVS = ['theorem', 'lemma', 'proposition', 'corollary',
          'definition', 'conjecture', 'claim', 'remark'];
        const END_RE = new RegExp(`\\\\end\\{(${THEOREM_ENVS.join('|')})\\}`, 'i');

        // Walk from current line downward to find \end{theorem|...}; if not
        // found, walk upward. Prefer the nearest \end below (user typed
        // the theorem and cursor is inside it), otherwise nearest above.
        let targetLine = null;
        const totalLines = model.getLineCount();
        for (let l = pos.lineNumber; l <= Math.min(pos.lineNumber + 40, totalLines); l++) {
          if (END_RE.test(model.getLineContent(l))) { targetLine = l; break; }
        }
        if (targetLine === null) {
          for (let l = pos.lineNumber - 1; l >= Math.max(1, pos.lineNumber - 40); l--) {
            if (END_RE.test(model.getLineContent(l))) { targetLine = l; break; }
          }
        }

        const insertAtLine = targetLine !== null ? targetLine + 1 : pos.lineNumber;
        const template = '% [PROVE IT: Medium]\n% SKETCH: \n';
        const range = new monaco.Range(insertAtLine, 1, insertAtLine, 1);

        editor.executeEdits('fermat-insert-sketch', [{
          range,
          text: template,
          forceMoveMarkers: true,
        }]);

        // Place cursor at end of the SKETCH: line (insertAtLine + 1)
        const sketchLineNum = insertAtLine + 1;
        const sketchLineLen = model.getLineLength(sketchLineNum);
        editor.setPosition({ lineNumber: sketchLineNum, column: sketchLineLen + 1 });
        editor.focus();
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => editor.layout());
      resizeObserver.observe(containerRef.current);

      return () => {
        resizeObserver.disconnect();
        contentDisposable.dispose();
        completionDisposables.forEach(d => d.dispose());
        // Dispose all per-tab models we created (not the initial one — Monaco
        // disposes that when the editor is disposed).
        for (const [tabId, model] of tabModelsRef.current) {
          if (tabId !== activeTabIdRef.current) {
            model.dispose();
          }
        }
        tabModelsRef.current.clear();
        tabViewStatesRef.current.clear();
        editor.dispose();
        editorInstanceRef.current = null;
      };
    } catch (err) {
      console.error('Failed to initialize Monaco editor:', err);
      setError(err.message);
    }
  }, []); // Only init once

  // ─── Switch Monaco model when the active tab changes ─────────────────────
  // Save the departing tab's view state (cursor + scroll), then switch the
  // editor to the new tab's model and restore its saved view state.
  useEffect(() => {
    const editor = editorInstanceRef.current;
    if (!editor) return;

    const prevTabId = activeTabIdRef.current;
    const nextTabId = activeTabId;

    if (prevTabId !== nextTabId) {
      // Save the outgoing tab's view state so we can restore it on return.
      tabViewStatesRef.current.set(prevTabId, editor.saveViewState());
      activeTabIdRef.current = nextTabId;
    }

    const model = tabModelsRef.current.get(nextTabId);
    if (model && editor.getModel() !== model) {
      editor.setModel(model);
      const vs = tabViewStatesRef.current.get(nextTabId);
      if (vs) editor.restoreViewState(vs);
    }
  }, [activeTabId]);

  // ─── Sync external content into the active model ─────────────────────────
  // This catches programmatic updates (proof insertion, handleNew clearing
  // content) that go through App's setTabs without calling _setTabContent.
  // The check `model.getValue() !== content` makes it a no-op for user typing.
  useEffect(() => {
    const editor = editorInstanceRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (model && model.getValue() !== content) {
      const position = editor.getPosition();
      model.setValue(content);
      if (position) editor.setPosition(position);
    }
  }, [content]);

  // ─── Update decorations for [PROVE IT] markers ───
  // P-05: debounced so we don't re-scan the full document on every keystroke
  // (was running a regex over every line on every `content` update, which is
  // O(N) per keystroke for a big document). 300ms debounce is imperceptible
  // for visual glyph refresh.
  useEffect(() => {
    const timer = setTimeout(() => {
      const editor = editorInstanceRef.current;
      if (!editor) return;

      const model = editor.getModel();
      if (!model) return;

      const text = model.getValue();
      const lines = text.split('\n');
      const newDecorations = [];
      const MARKER_REGEX = /\[PROVE\s+IT:\s*(Easy|Medium|Hard)/i;

      lines.forEach((line, idx) => {
        const match = line.match(MARKER_REGEX);
        if (match) {
          const difficulty = match[1];
          const lineNum = idx + 1;
          newDecorations.push({
            range: new monaco.Range(lineNum, 1, lineNum, 1),
            options: {
              isWholeLine: true,
              className: 'prove-it-decoration',
              glyphMarginClassName: `prove-it-glyph difficulty-${difficulty.toLowerCase()}`,
              glyphMarginHoverMessage: {
                value: `**[PROVE IT: ${difficulty}]** — Click "Prove All" or right-click to prove this`,
              },
            },
          });
        }
      });

      decorationsRef.current = editor.deltaDecorations(
        decorationsRef.current,
        newDecorations,
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [content, proofTasks]);

  if (error) {
    return (
      <div style={{
        padding: 24, color: 'var(--red)', fontFamily: 'var(--font-mono)',
        fontSize: 13, background: 'var(--bg-primary)', height: '100%',
      }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Editor failed to load</div>
        <div>{error}</div>
        <div style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 11 }}>
          Try running: npm install monaco-editor vite-plugin-monaco-editor
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
