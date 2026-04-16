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
  });

  // Load current engine from main process on mount
  useEffect(() => {
    async function loadEngine() {
      if (window.api?.tex?.getEngine) {
        const engine = await window.api.tex.getEngine();
        if (engine) {
          setSettings(prev => ({ ...prev, texEngine: engine }));
        }
      }
    }
    loadEngine();
  }, []);

  const update = (key, value) => setSettings(prev => ({ ...prev, [key]: value }));

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
          onChange={e => update('maxConcurrent', parseInt(e.target.value))}
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
          <input
            type="checkbox"
            checked={settings.autoInlineEasy}
            onChange={e => update('autoInlineEasy', e.target.checked)}
          />
          Auto-inline Easy proofs (skip review)
        </label>

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
