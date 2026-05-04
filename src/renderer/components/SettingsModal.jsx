import React, { useState, useEffect } from 'react';

/**
 * Settings Modal — configure AI models, API keys, compilation engine, etc.
 */
export default function SettingsModal({ onClose }) {
  const [settings, setSettings] = useState({
    claudeApiKey: '',
    claudeModel: 'claude-sonnet-4-6',
    texEngine: 'tectonic',
    maxConcurrent: 3,
    autoInlineLow: true,
    maxProofWidth: 3,
    maxProofStages: 3,
    enableSourceSearch: true,
    sourceSearchProviders: 'arxiv,crossref,local_bib,local_pdf,project_web',
    maxSources: 6,
    maxResultsPerQuery: 3,
    // Lean 4
    verificationMode: 'off',   // 'off' | 'lean'
    leanBinaryPath: '',        // empty → auto-detect
    leanMaxRetries: 3,
    leanUsesMathlib: true,     // default on — verify() falls back to core-only if cache missing
    leanUseRepl: true,         // use persistent REPL (warm Mathlib env, faster)
  });
  const [leanDetect, setLeanDetect] = useState(null); // { available, path, version } | null
  const [leanTesting, setLeanTesting] = useState(false);

  // Load persisted settings from main process on mount.
  useEffect(() => {
    async function loadPersisted() {
      try {
        const stored = await window.api?.settings?.load?.();
        if (stored) {
          const { copilot, texEngine } = stored;
          setSettings(prev => ({
            ...prev,
            claudeApiKey:      copilot?.models?.claude?.apiKey              ?? prev.claudeApiKey,
            claudeModel:       copilot?.models?.claude?.model               ?? prev.claudeModel,
            texEngine:         texEngine                                    ?? prev.texEngine,
            maxConcurrent:     copilot?.maxConcurrent                       ?? prev.maxConcurrent,
            autoInlineLow:     Array.isArray(copilot?.autoInlineEffort)
              ? copilot.autoInlineEffort.includes('low')
              : prev.autoInlineLow,
            maxProofWidth:     copilot?.maxProofWidth                       ?? prev.maxProofWidth,
            maxProofStages:    copilot?.maxProofStages                      ?? prev.maxProofStages,
            enableSourceSearch: copilot?.enableSourceSearch                 ?? prev.enableSourceSearch,
            sourceSearchProviders: Array.isArray(copilot?.sourceSearchProviders)
              ? copilot.sourceSearchProviders.join(',')
              : (copilot?.sourceSearchProviders ?? prev.sourceSearchProviders),
            maxSources:        copilot?.maxSources                          ?? prev.maxSources,
            maxResultsPerQuery: copilot?.maxResultsPerQuery                 ?? prev.maxResultsPerQuery,
            verificationMode:  copilot?.verificationMode                    ?? prev.verificationMode,
            leanBinaryPath:    copilot?.lean?.binaryPath                    ?? prev.leanBinaryPath,
            leanMaxRetries:    copilot?.lean?.maxRetries                    ?? prev.leanMaxRetries,
            leanUsesMathlib:   copilot?.lean?.usesMathlib                   ?? prev.leanUsesMathlib,
            leanUseRepl:       copilot?.lean?.useRepl                       ?? prev.leanUseRepl,
          }));
          return;
        }
      } catch (e) {
        console.warn('[SettingsModal] settings.load failed:', e?.message);
      }
      if (window.api?.tex?.getEngine) {
        const engine = await window.api.tex.getEngine();
        if (engine) setSettings(prev => ({ ...prev, texEngine: engine }));
      }
    }
    loadPersisted();
  }, []);

  const update = (key, value) => setSettings(prev => ({ ...prev, [key]: value }));

  // Numeric inputs never store NaN — fall back to safe minimum.
  const updateInt = (key, raw, min = 1, max = 10) => {
    const n = parseInt(raw, 10);
    const safe = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
    setSettings(prev => ({ ...prev, [key]: safe }));
  };

  const handleTestLean = async () => {
    setLeanTesting(true);
    try {
      const result = await window.api?.lean?.getPath(settings.leanBinaryPath || undefined);
      setLeanDetect(result || { available: false, path: null, version: null });
    } catch (e) {
      setLeanDetect({ available: false, path: null, version: e.message });
    } finally {
      setLeanTesting(false);
    }
  };

  const handleSave = async () => {
    if (window.api) {
      await window.api.copilot.configure({
        defaultModel: 'claude',
        models: {
          claude: { apiKey: settings.claudeApiKey, model: settings.claudeModel },
        },
        maxConcurrent: settings.maxConcurrent,
        autoInlineEffort: settings.autoInlineLow ? ['low'] : [],
        skipVerifyEffort: ['low'],
        maxProofWidth: settings.maxProofWidth,
        maxProofStages: settings.maxProofStages,
        enableSourceSearch: settings.enableSourceSearch,
        sourceSearchProviders: settings.sourceSearchProviders.split(',').map(s => s.trim()).filter(Boolean),
        maxSources: settings.maxSources,
        maxResultsPerQuery: settings.maxResultsPerQuery,
        verificationMode: settings.verificationMode,
        lean: {
          binaryPath:   settings.leanBinaryPath,
          maxRetries:   settings.leanMaxRetries,
          usesMathlib:  settings.leanUsesMathlib,
          useRepl:      settings.leanUseRepl,
        },
      });
      if (window.api.tex?.setEngine) {
        await window.api.tex.setEngine(settings.texEngine);
      }
    }
    onClose();
  };

  const leanActive = settings.verificationMode === 'lean';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>

        {/* ── Scrollable content ─────────────────────────────────────── */}
        <div className="modal-body">
          <h2>Settings</h2>

          {/* ── AI ──────────────────────────────────────────────────── */}
          <label>Claude API Key</label>
          <input
            type="password"
            value={settings.claudeApiKey}
            onChange={e => update('claudeApiKey', e.target.value)}
            placeholder="sk-ant-..."
          />

          <label>Claude Model</label>
          <select value={settings.claudeModel} onChange={e => update('claudeModel', e.target.value)}>
            <option value="claude-opus-4-7">Claude Opus 4.7 (most capable)</option>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (fastest)</option>
          </select>

          {/* ── LaTeX ───────────────────────────────────────────────── */}
          <label>LaTeX Engine</label>
          <select value={settings.texEngine} onChange={e => update('texEngine', e.target.value)}>
            <option value="tectonic">tectonic</option>
            <option value="pdflatex">pdflatex</option>
            <option value="xelatex">xelatex</option>
            <option value="lualatex">lualatex</option>
          </select>

          {/* ── Proof generation ────────────────────────────────────── */}
          <label>Max Concurrent Proofs</label>
          <input
            type="number" min={1} max={10}
            value={settings.maxConcurrent}
            onChange={e => updateInt('maxConcurrent', e.target.value, 1, 10)}
          />

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
            <input
              type="checkbox"
              checked={settings.autoInlineLow}
              onChange={e => update('autoInlineLow', e.target.checked)}
            />
            Auto-inline low-effort proofs (skip review)
          </label>

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 14 }}>
              Max Effort Pipeline
            </div>

            <label>Width</label>
            <input
              type="number" min={2} max={5}
              value={settings.maxProofWidth}
              onChange={e => updateInt('maxProofWidth', e.target.value, 2, 5)}
            />

            <label style={{ marginTop: 14 }}>Stages</label>
            <input
              type="number" min={1} max={6}
              value={settings.maxProofStages}
              onChange={e => updateInt('maxProofStages', e.target.value, 1, 6)}
            />

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
              <input
                type="checkbox"
                checked={settings.enableSourceSearch}
                onChange={e => update('enableSourceSearch', e.target.checked)}
              />
              Native source search for max
            </label>

            <label style={{ marginTop: 14 }}>Search Providers</label>
            <input
              type="text"
              value={settings.sourceSearchProviders}
              onChange={e => update('sourceSearchProviders', e.target.value)}
            />

            <label style={{ marginTop: 14 }}>Max Sources</label>
            <input
              type="number" min={1} max={20}
              value={settings.maxSources}
              onChange={e => updateInt('maxSources', e.target.value, 1, 20)}
            />

            <label style={{ marginTop: 14 }}>Results Per Query</label>
            <input
              type="number" min={1} max={8}
              value={settings.maxResultsPerQuery}
              onChange={e => updateInt('maxResultsPerQuery', e.target.value, 1, 8)}
            />
          </div>

          {/* ── Lean 4 Verification ──────────────────────────────────── */}
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 14 }}>
              Lean 4 Verification
            </div>

            <label>Mode</label>
            <select
              value={settings.verificationMode}
              onChange={e => update('verificationMode', e.target.value)}
            >
              <option value="off">Off — LaTeX proof only</option>
              <option value="lean">Lean 4 — verify generated proof</option>
            </select>

            {leanActive && (
              <>
                {/* lean binary path */}
                <label style={{ marginTop: 14 }}>
                  lean binary path
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>
                    (empty = auto-detect)
                  </span>
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={settings.leanBinaryPath}
                    onChange={e => { update('leanBinaryPath', e.target.value); setLeanDetect(null); }}
                    placeholder="~/.elan/bin/lean"
                    style={{ flex: 1 }}
                  />
                  <button
                    onClick={handleTestLean}
                    disabled={leanTesting}
                    style={{
                      background: 'var(--bg-hover)', border: '1px solid var(--border)',
                      color: 'var(--text-secondary)', padding: '4px 10px',
                      borderRadius: 3, cursor: 'pointer', fontSize: 11, flexShrink: 0,
                    }}
                  >
                    {leanTesting ? 'Testing…' : 'Test'}
                  </button>
                </div>

                {leanDetect && (
                  <div style={{
                    marginTop: 6, padding: '6px 10px', borderRadius: 3, fontSize: 11,
                    background: leanDetect.available ? 'rgba(80,160,120,0.12)' : 'rgba(200,80,60,0.1)',
                    color: leanDetect.available ? 'var(--verdigris)' : 'var(--vermillion)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {leanDetect.available
                      ? `✓ ${leanDetect.version}  (${leanDetect.path})`
                      : `✗ Not found${leanDetect.version ? ': ' + leanDetect.version : ''}`
                    }
                  </div>
                )}

                <label style={{ marginTop: 14 }}>Max retries on lean failure</label>
                <input
                  type="number" min={1} max={10}
                  value={settings.leanMaxRetries}
                  onChange={e => updateInt('leanMaxRetries', e.target.value, 1, 10)}
                />

                {/* Mathlib */}
                <label style={{ marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={settings.leanUsesMathlib}
                    onChange={e => update('leanUsesMathlib', e.target.checked)}
                    style={{ marginTop: 2, flexShrink: 0 }}
                  />
                  <span>
                    Import Mathlib
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontWeight: 400 }}>
                      (requires <code style={{ fontSize: 10 }}>lake exe cache get</code> — ~5 GB download)
                    </span>
                  </span>
                </label>

                {/* REPL — only meaningful when Mathlib is on */}
                <label style={{ marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={settings.leanUseRepl}
                    onChange={e => update('leanUseRepl', e.target.checked)}
                    style={{ marginTop: 2, flexShrink: 0 }}
                  />
                  <span>
                    Persistent REPL
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontWeight: 400 }}>
                      (loads Mathlib once, ~30 s warm-up — then each proof is fast)
                    </span>
                  </span>
                </label>
              </>
            )}
          </div>
        </div>

        {/* ── Sticky footer ───────────────────────────────────────────── */}
        <div className="modal-actions">
          <button onClick={onClose} style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}>
            Cancel
          </button>
          <button onClick={handleSave} style={{ background: 'var(--accent)', color: 'var(--bg-primary)' }}>
            Save
          </button>
        </div>

      </div>
    </div>
  );
}
