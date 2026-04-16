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
    autoInlineEasy: true,
    // Lean 4
    verificationMode: 'off',   // 'off' | 'lean'
    leanBinaryPath: '',        // empty → auto-detect
    leanMaxRetries: 3,
    leanUsesMathlib: false,    // opt-in: requires lean-workspace with cache
  });
  const [leanDetect, setLeanDetect] = useState(null); // { available, path, version } | null
  const [leanTesting, setLeanTesting] = useState(false);

  // Load persisted settings from main process on mount (B-01 fix).
  // Falls back to current engine + defaults if no persisted settings exist.
  useEffect(() => {
    async function loadPersisted() {
      try {
        const stored = await window.api?.settings?.load?.();
        if (stored) {
          const { copilot, texEngine } = stored;
          setSettings(prev => ({
            ...prev,
            claudeApiKey:      copilot?.models?.claude?.apiKey         ?? prev.claudeApiKey,
            claudeModel:       copilot?.models?.claude?.model          ?? prev.claudeModel,
            texEngine:         texEngine                               ?? prev.texEngine,
            maxConcurrent:     copilot?.maxConcurrent                  ?? prev.maxConcurrent,
            autoInlineEasy:    copilot?.autoInlineDifficulty?.includes('Easy') ?? prev.autoInlineEasy,
            verificationMode:  copilot?.verificationMode               ?? prev.verificationMode,
            leanBinaryPath:    copilot?.lean?.binaryPath               ?? prev.leanBinaryPath,
            leanMaxRetries:    copilot?.lean?.maxRetries               ?? prev.leanMaxRetries,
            leanUsesMathlib:   copilot?.lean?.usesMathlib              ?? prev.leanUsesMathlib,
          }));
          return;
        }
      } catch (e) {
        console.warn('[SettingsModal] settings.load failed, falling back:', e?.message);
      }
      // Fallback: fetch current tex engine from the compiler
      if (window.api?.tex?.getEngine) {
        const engine = await window.api.tex.getEngine();
        if (engine) setSettings(prev => ({ ...prev, texEngine: engine }));
      }
    }
    loadPersisted();
  }, []);

  const update = (key, value) => setSettings(prev => ({ ...prev, [key]: value }));

  // B-11: numeric inputs must never store NaN — an empty/invalid input should
  // fall back to a safe minimum (1). parseInt('') === NaN and would otherwise
  // disable the copilot queue (while-loop `running < NaN` is always false).
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
      // Save copilot config
      await window.api.copilot.configure({
        defaultModel: 'claude',
        models: {
          claude: { apiKey: settings.claudeApiKey, model: settings.claudeModel },
        },
        maxConcurrent: settings.maxConcurrent,
        autoInlineDifficulty: settings.autoInlineEasy ? ['Easy'] : [],
        verificationMode: settings.verificationMode,
        lean: {
          binaryPath: settings.leanBinaryPath,
          maxRetries: settings.leanMaxRetries,
          usesMathlib: settings.leanUsesMathlib,
        },
      });

      // Save TeX engine
      if (window.api.tex?.setEngine) {
        await window.api.tex.setEngine(settings.texEngine);
      }
    }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Settings</h2>

        <label>Claude API Key</label>
        <input
          type="password"
          value={settings.claudeApiKey}
          onChange={e => update('claudeApiKey', e.target.value)}
          placeholder="sk-ant-..."
        />

        <label>Claude Model</label>
        <select value={settings.claudeModel} onChange={e => update('claudeModel', e.target.value)}>
          <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
          <option value="claude-opus-4-6">Claude Opus 4.6</option>
          <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
        </select>

        <label>LaTeX Engine</label>
        <select value={settings.texEngine} onChange={e => update('texEngine', e.target.value)}>
          <option value="tectonic">tectonic</option>
          <option value="pdflatex">pdflatex</option>
          <option value="xelatex">xelatex</option>
          <option value="lualatex">lualatex</option>
        </select>

        <label>Max Concurrent Proofs</label>
        <input
          type="number"
          min={1}
          max={10}
          value={settings.maxConcurrent}
          onChange={e => updateInt('maxConcurrent', e.target.value, 1, 10)}
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
          <input
            type="checkbox"
            checked={settings.autoInlineEasy}
            onChange={e => update('autoInlineEasy', e.target.checked)}
          />
          Auto-inline Easy proofs (skip review)
        </label>

        {/* ── Lean Verification ─────────────────────────────────────── */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)', marginBottom: 12 }}>
            Lean 4 Verification
          </div>

          <label>Mode</label>
          <select
            value={settings.verificationMode}
            onChange={e => update('verificationMode', e.target.value)}
          >
            <option value="off">Off (LaTeX proof only)</option>
            <option value="lean">Lean 4 — verify generated proof</option>
          </select>

          {settings.verificationMode === 'lean' && (
            <>
              <label style={{ marginTop: 12 }}>
                lean binary path
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>
                  (empty = auto-detect from PATH / ~/.elan/bin/lean)
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
                  style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 11, flexShrink: 0 }}
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

              <label style={{ marginTop: 12 }}>Max retries on lean failure</label>
              <input
                type="number" min={1} max={10}
                value={settings.leanMaxRetries}
                onChange={e => updateInt('leanMaxRetries', e.target.value, 1, 10)}
              />

              <label style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.leanUsesMathlib}
                  onChange={e => update('leanUsesMathlib', e.target.checked)}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <span>
                  Import Mathlib
                  <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                    (requires <code>lake exe cache get</code> in lean-workspace — ~5–10 GB download)
                  </span>
                </span>
              </label>
            </>
          )}
        </div>

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
