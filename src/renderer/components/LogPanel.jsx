import React, { useState, useEffect, useRef } from 'react';

/**
 * Log Panel — bottom-docked, shows main-process console output.
 *
 * Features:
 *  - Live streaming of log entries from main process
 *  - Level filtering (info / warn / error)
 *  - Auto-scroll to bottom (toggle)
 *  - Clear button
 *  - Search filter
 */
export default function LogPanel({ onClose, height = 220 }) {
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('all'); // all | info | warn | error
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef(null);

  // Load buffered entries + subscribe to new ones
  useEffect(() => {
    if (!window.api?.log) return;
    let cancelled = false;

    window.api.log.getBuffer().then((buf) => {
      if (!cancelled && buf) setEntries(buf);
    });

    const unsub = window.api.log.onEntry((entry) => {
      setEntries((prev) => {
        const next = [...prev, entry];
        if (next.length > 2000) next.shift();
        return next;
      });
    });

    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleClear = async () => {
    if (window.api?.log) await window.api.log.clear();
    setEntries([]);
  };

  const visible = entries.filter((e) => {
    if (levelFilter !== 'all' && e.level !== levelFilter) return false;
    if (filter && !e.text.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  const levelColor = (level) => {
    switch (level) {
      case 'error': return 'var(--red, #f38ba8)';
      case 'warn': return 'var(--yellow, #f9e2af)';
      default: return 'var(--text-secondary, #a6adc8)';
    }
  };

  return (
    <div
      style={{
        height,
        background: 'var(--bg-panel, #1e1e2e)',
        borderTop: '1px solid var(--border, #313244)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 11,
      }}
    >
      {/* Header / controls */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 8px',
          borderBottom: '1px solid var(--border, #313244)',
          background: 'var(--bg-subtle, #181825)',
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Log</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          {visible.length}/{entries.length}
        </span>

        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          style={{
            background: 'var(--bg-input, #313244)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            fontSize: 10, padding: '1px 4px', borderRadius: 3,
          }}
        >
          <option value="all">all</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>

        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter..."
          style={{
            flex: '0 0 180px',
            background: 'var(--bg-input, #313244)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            fontSize: 10, padding: '1px 6px', borderRadius: 3,
          }}
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            style={{ margin: 0 }}
          />
          auto-scroll
        </label>

        <div style={{ flex: 1 }} />

        <button
          onClick={handleClear}
          style={{
            background: 'none', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
            fontSize: 10, padding: '1px 6px', borderRadius: 3,
          }}
        >
          Clear
        </button>
        <button
          onClick={onClose}
          title="Hide log"
          style={{
            background: 'none', border: 'none',
            color: 'var(--text-secondary)', cursor: 'pointer',
            fontSize: 14, padding: '0 4px',
          }}
        >
          ×
        </button>
      </div>

      {/* Log lines */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 8px',
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {visible.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            No log entries yet. Compile a file or submit a proof to see backend output here.
          </div>
        ) : (
          visible.map((e, i) => (
            <div key={i} style={{ lineHeight: 1.5 }}>
              <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{e.ts}</span>
              <span style={{ color: levelColor(e.level) }}>{e.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
