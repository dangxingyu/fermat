import React, { useEffect, useRef, useState } from 'react';

/**
 * LeanPanel
 *
 * Displays the Lean 4 verification result for the most recently completed
 * proof task that included a lean verification pass.
 *
 * Layout:
 *   ┌── header: theorem label · attempt X/N · status badge · cancel ─┐
 *   ├── generated Lean code  (read-only Monaco or <pre> fallback)      │
 *   ├── lean stdout/stderr log (scrollable)                            │
 *   └── action row: Accept | Reject | Retry manually                  ┘
 *
 * Props:
 *   leanState   — { taskId, label, phase, attempt, maxAttempts,
 *                   leanCode, leanLog, leanErrors, leanVerified,
 *                   outputLines }
 *   onCancel    — () => void
 */
export default function LeanPanel({ leanState }) {
  const logRef = useRef(null);
  const [codeExpanded, setCodeExpanded] = useState(true);

  // Auto-scroll log to bottom as new lines arrive
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [leanState?.outputLines]);

  if (!leanState) {
    return (
      <div style={styles.empty}>
        <div style={{ fontSize: 32, opacity: 0.2 }}>λ</div>
        <div style={{ marginTop: 8 }}>No Lean verification yet</div>
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>
          Enable Lean mode in Settings, then prove a theorem.
        </div>
      </div>
    );
  }

  const { label, phase, attempt, maxAttempts, leanCode, leanLog, leanErrors, leanVerified, outputLines } = leanState;

  const phaseLabel = {
    'generating-lean': 'Generating Lean code…',
    'verifying':       'Running lean…',
    'lean-retry':      `Retry ${attempt} / ${maxAttempts}…`,
    'lean-verified':   '✓ Verified',
    'lean-failed':     '✗ Verification failed',
    'idle':            'Ready',
  }[phase] ?? phase;

  const statusColor = {
    'lean-verified': 'var(--verdigris)',
    'lean-failed':   'var(--vermillion)',
  }[phase] ?? 'var(--text-muted)';

  const isActive = ['generating-lean', 'verifying', 'lean-retry'].includes(phase);

  return (
    <div style={styles.panel}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={styles.header}>
        <span style={styles.label} title={label}>{label || 'Lean Verification'}</span>
        {isActive && attempt && (
          <span style={styles.attempt}>attempt {attempt}/{maxAttempts}</span>
        )}
        <span style={{ ...styles.status, color: statusColor }}>{phaseLabel}</span>
      </div>

      {/* ── Generated Lean code ────────────────────────────────────────── */}
      {leanCode && (
        <div style={styles.section}>
          <div
            style={styles.sectionHeader}
            onClick={() => setCodeExpanded(v => !v)}
          >
            <span style={styles.chevron}>{codeExpanded ? '▾' : '▸'}</span>
            Generated Lean 4 code
          </div>
          {codeExpanded && (
            <pre style={styles.code}>{leanCode}</pre>
          )}
        </div>
      )}

      {/* ── Live lean output ───────────────────────────────────────────── */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          lean output
          {leanVerified === true  && <span style={{ color: 'var(--verdigris)', marginLeft: 8 }}>✓ exit 0</span>}
          {leanVerified === false && leanErrors?.length > 0 && (
            <span style={{ color: 'var(--vermillion)', marginLeft: 8 }}>
              ✗ {leanErrors.length} error{leanErrors.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div ref={logRef} style={styles.log}>
          {outputLines && outputLines.length > 0
            ? outputLines.map((line, i) => (
                <div key={i} style={{
                  color: line.includes(': error:') ? 'var(--vermillion)'
                       : line.includes(': warning:') ? '#d4a016'
                       : 'var(--text-secondary)',
                }}>{line}</div>
              ))
            : <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                {isActive ? 'Waiting for output…' : 'No output'}
              </div>
          }
        </div>
      </div>

      {/* ── Error details ─────────────────────────────────────────────── */}
      {leanErrors && leanErrors.filter(e => e.severity === 'error').length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>Error details</div>
          {leanErrors.filter(e => e.severity === 'error').map((err, i) => (
            <div key={i} style={styles.errorRow}>
              <span style={styles.errorLoc}>line {err.line}:{err.col}</span>
              <span style={styles.errorMsg}>{err.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  panel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: '#16110d',
    borderLeft: '1px solid var(--border)',
    overflow: 'hidden',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    minWidth: 0,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-display)',
    fontStyle: 'italic',
    fontSize: 13,
    background: '#16110d',
    borderLeft: '1px solid var(--border)',
    minWidth: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    fontFamily: 'var(--font-display)',
    fontStyle: 'italic',
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  label: {
    fontWeight: 600,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 200,
    flexShrink: 1,
  },
  attempt: {
    fontSize: 10,
    color: 'var(--text-faint)',
    flexShrink: 0,
  },
  status: {
    marginLeft: 'auto',
    flexShrink: 0,
    fontWeight: 500,
  },
  section: {
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  sectionHeader: {
    padding: '4px 12px',
    fontSize: 10,
    color: 'var(--text-muted)',
    background: 'var(--bg-secondary)',
    cursor: 'pointer',
    userSelect: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  chevron: {
    fontSize: 9,
    color: 'var(--text-faint)',
  },
  code: {
    margin: 0,
    padding: '8px 12px',
    fontSize: 11,
    lineHeight: 1.5,
    color: 'var(--text-primary)',
    background: 'var(--bg-primary)',
    overflowX: 'auto',
    maxHeight: 240,
    overflowY: 'auto',
    whiteSpace: 'pre',
  },
  log: {
    padding: '6px 12px',
    maxHeight: 180,
    overflowY: 'auto',
    lineHeight: 1.6,
    color: 'var(--text-secondary)',
    background: 'var(--bg-primary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  errorRow: {
    display: 'flex',
    gap: 10,
    padding: '3px 12px',
    background: 'rgba(200,80,60,0.06)',
  },
  errorLoc: {
    color: 'var(--text-faint)',
    flexShrink: 0,
    minWidth: 80,
  },
  errorMsg: {
    color: 'var(--vermillion)',
  },
};
