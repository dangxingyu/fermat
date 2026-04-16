import React, { useEffect, useRef, useState } from 'react';

/**
 * LeanPanel
 *
 * Displays the Lean 4 verification pipeline state with three key modes:
 *
 *   1. Active (sketching / filling / checking) — live log + progress
 *   2. Statement Review — paused, awaiting user confirm/edit/cancel
 *   3. Verified — theorem statement highlighted; proof body folded
 *      "Lean verified ✓ — proof is correct. Please confirm the theorem
 *       statement matches your intent."
 *   4. Partial / Failed — error details + sorry list
 *
 * Props:
 *   leanState   — { taskId, label, phase, attempt, maxAttempts,
 *                   leanCode, leanLog, leanErrors, leanVerified,
 *                   leanStatement, sorries, sketch, statement,
 *                   outputLines }
 *   onConfirmStatement  — (taskId) => void
 *   onEditStatement     — (taskId, newCode) => void
 *   onCancelStatement   — (taskId) => void
 */
export default function LeanPanel({
  leanState,
  onConfirmStatement,
  onEditStatement,
  onCancelStatement,
}) {
  const logRef = useRef(null);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [proofBodyExpanded, setProofBodyExpanded] = useState(false);
  // Statement editing state: false | string (current edit content)
  const [editingCode, setEditingCode] = useState(false);

  // Auto-scroll log to bottom as new lines arrive
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [leanState?.outputLines]);

  // Reset edit state when the review phase ends
  useEffect(() => {
    if (leanState?.phase !== 'lean-statement-review') {
      setEditingCode(false);
    }
  }, [leanState?.phase]);

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

  const {
    label, phase, attempt, maxAttempts,
    leanCode, leanErrors, leanVerified,
    leanStatement, sorries, sketch, statement,
    outputLines,
  } = leanState;

  // ── Derived helpers ──────────────────────────────────────────────────────

  const phaseLabel = {
    'lean-sketching':          'Generating sketch…',
    'lean-sketch-retry':       `Sketch retry ${attempt} / ${maxAttempts}…`,
    'lean-sketch-checking':    'Checking sketch…',
    'lean-sketch-ok':          'Sketch ok',
    'lean-statement-review':   '⏸ Review required',
    'lean-filling':            `Filling subgoals…`,
    'lean-fill-ok':            'Subgoal filled',
    'lean-fill-retry':         'Subgoal retry…',
    'lean-fill-failed':        'Subgoal failed',
    'lean-verified':           '✓ Verified',
    'lean-partial':            '◑ Partially verified',
    'lean-failed':             '✗ Failed',
    'idle':                    'Ready',
  }[phase] ?? phase;

  const statusColor = {
    'lean-verified':         'var(--verdigris)',
    'lean-partial':          '#d4a016',
    'lean-failed':           'var(--vermillion)',
    'lean-statement-review': 'var(--accent)',
  }[phase] ?? 'var(--text-muted)';

  const isActive = [
    'lean-sketching', 'lean-sketch-retry', 'lean-sketch-checking',
    'lean-filling', 'lean-fill-ok', 'lean-fill-retry', 'lean-fill-failed',
  ].includes(phase);

  const isReview   = phase === 'lean-statement-review';
  const isVerified = phase === 'lean-verified';
  const isFailed   = phase === 'lean-failed' || phase === 'lean-partial';

  // The statement to display: from the review event, or parsed from final code
  const displayStatement = statement || leanStatement || null;

  // Proof body: everything after the statement in leanCode
  const proofBody = (() => {
    if (!leanCode || !displayStatement) return leanCode || null;
    const idx = leanCode.indexOf(displayStatement);
    if (idx < 0) return leanCode;
    const afterStatement = leanCode.slice(idx + displayStatement.length);
    return afterStatement.trim() || null;
  })();

  // ── Statement review — edit mode ─────────────────────────────────────────
  const handleConfirmEdit = () => {
    if (typeof editingCode === 'string' && onEditStatement) {
      onEditStatement(leanState.taskId, editingCode);
    }
    setEditingCode(false);
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={styles.panel}>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div style={styles.header}>
        <span style={styles.label} title={label}>{label || 'Lean Verification'}</span>
        {isActive && attempt && (
          <span style={styles.attempt}>attempt {attempt}/{maxAttempts}</span>
        )}
        <span style={{ ...styles.status, color: statusColor }}>{phaseLabel}</span>
      </div>

      {/* ════════════════════════════════════════════════════════════ */}
      {/* MODE A: Statement Review (pipeline paused)                  */}
      {/* ════════════════════════════════════════════════════════════ */}
      {isReview && (
        <div style={styles.reviewPanel}>
          <div style={styles.reviewTitle}>
            Confirm the theorem statement before Lean fills the proof.
          </div>

          {editingCode !== false ? (
            /* ── Edit mode ── */
            <>
              <textarea
                style={styles.editArea}
                value={editingCode}
                onChange={e => setEditingCode(e.target.value)}
                spellCheck={false}
              />
              <div style={styles.reviewActions}>
                <button
                  style={{ ...styles.btn, ...styles.btnPrimary }}
                  onClick={handleConfirmEdit}
                >
                  Confirm Edit
                </button>
                <button
                  style={{ ...styles.btn, ...styles.btnSecondary }}
                  onClick={() => setEditingCode(false)}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            /* ── Statement display + action buttons ── */
            <>
              <pre style={styles.statementBox}>
                {displayStatement || sketch || '(no statement extracted)'}
              </pre>
              <div style={styles.reviewActions}>
                <button
                  style={{ ...styles.btn, ...styles.btnPrimary }}
                  onClick={() => onConfirmStatement?.(leanState.taskId)}
                >
                  Confirm
                </button>
                <button
                  style={{ ...styles.btn, ...styles.btnSecondary }}
                  onClick={() => setEditingCode(sketch || '')}
                >
                  Edit
                </button>
                <button
                  style={{ ...styles.btn, ...styles.btnDanger }}
                  onClick={() => onCancelStatement?.(leanState.taskId)}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════ */}
      {/* MODE B: Verified — statement prominent, proof body folded   */}
      {/* ════════════════════════════════════════════════════════════ */}
      {isVerified && displayStatement && (
        <div style={styles.verifiedPanel}>
          <div style={styles.verifiedBadge}>
            Lean verified ✓ — proof is correct. Please confirm the theorem statement matches your intent.
          </div>
          <pre style={styles.verifiedStatement}>{displayStatement}</pre>

          {/* Proof body — collapsed by default */}
          {proofBody && (
            <div style={styles.section}>
              <div
                style={{ ...styles.sectionHeader, cursor: 'pointer' }}
                onClick={() => setProofBodyExpanded(v => !v)}
              >
                <span style={styles.chevron}>{proofBodyExpanded ? '▾' : '▸'}</span>
                Proof body (Lean-verified, no review needed)
              </div>
              {proofBodyExpanded && (
                <pre style={{ ...styles.code, color: 'var(--text-faint)' }}>{proofBody}</pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════ */}
      {/* MODE C: Active / Failed — sketch code + sorry list + log    */}
      {/* ════════════════════════════════════════════════════════════ */}
      {!isReview && !isVerified && (
        <>
          {/* ── Sketch / final code ──────────────────────────────── */}
          {leanCode && (
            <div style={styles.section}>
              <div
                style={styles.sectionHeader}
                onClick={() => setCodeExpanded(v => !v)}
              >
                <span style={styles.chevron}>{codeExpanded ? '▾' : '▸'}</span>
                {isVerified ? 'Verified Lean 4 code' : 'Generated Lean 4 code'}
              </div>
              {codeExpanded && (
                <pre style={styles.code}>{leanCode}</pre>
              )}
            </div>
          )}

          {/* ── Sorry / subgoal list ──────────────────────────────── */}
          {sorries && sorries.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionHeader}>
                Subgoals&nbsp;
                <span style={{ color: 'var(--text-faint)' }}>
                  ({sorries.filter(s => s.status === 'filled').length}/{sorries.length} filled)
                </span>
              </div>
              <div style={styles.sorryList}>
                {sorries.map((s, i) => (
                  <div key={i} style={styles.sorryRow}>
                    <span style={styles.sorryIdx}>#{i + 1}</span>
                    <span style={styles.sorryLoc}>line {s.line}</span>
                    {s.expectedType && (
                      <span style={styles.sorryType} title={s.expectedType}>
                        {s.expectedType.length > 40
                          ? s.expectedType.slice(0, 38) + '…'
                          : s.expectedType}
                      </span>
                    )}
                    <span style={{
                      ...styles.sorryStatus,
                      color: s.status === 'filled'  ? 'var(--verdigris)'
                           : s.status === 'failed'  ? 'var(--vermillion)'
                           : s.status === 'filling' ? '#d4a016'
                           : 'var(--text-faint)',
                    }}>
                      {s.status === 'filled'  ? '✓ filled'
                     : s.status === 'failed'  ? '✗ failed'
                     : s.status === 'filling' ? '… filling'
                     : '○ pending'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Live lean output (always shown when not in review) ───── */}
      {!isReview && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            lean output
            {leanVerified === true  && <span style={{ color: 'var(--verdigris)', marginLeft: 8 }}>✓ exit 0</span>}
            {leanVerified === false && leanErrors?.length > 0 && (
              <span style={{ color: 'var(--vermillion)', marginLeft: 8 }}>
                ✗ {leanErrors.filter(e => e.severity === 'error').length} error{leanErrors.filter(e => e.severity === 'error').length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div ref={logRef} style={styles.log}>
            {outputLines && outputLines.length > 0
              ? outputLines.map((line, i) => (
                  <div key={i} style={{
                    color: line.includes(': error:')   ? 'var(--vermillion)'
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
      )}

      {/* ── Error details ─────────────────────────────────────────── */}
      {!isReview && leanErrors && leanErrors.filter(e => e.severity === 'error').length > 0 && (
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

  // ── Sorry list ──────────────────────────────────────────────────────────
  sorryList: {
    background: 'var(--bg-primary)',
    padding: '4px 0',
  },
  sorryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '3px 12px',
    borderBottom: '1px solid rgba(255,255,255,0.03)',
  },
  sorryIdx: {
    color: 'var(--text-faint)',
    fontSize: 10,
    minWidth: 24,
    flexShrink: 0,
  },
  sorryLoc: {
    color: 'var(--text-faint)',
    fontSize: 10,
    minWidth: 52,
    flexShrink: 0,
  },
  sorryType: {
    color: 'var(--text-muted)',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 10,
  },
  sorryStatus: {
    fontSize: 10,
    flexShrink: 0,
    fontWeight: 500,
  },

  // ── Statement review panel ───────────────────────────────────────────────
  reviewPanel: {
    padding: '14px 14px 12px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    background: 'rgba(100,160,255,0.04)',
  },
  reviewTitle: {
    fontFamily: 'var(--font-display)',
    fontStyle: 'italic',
    fontSize: 11,
    color: 'var(--text-muted)',
    lineHeight: 1.4,
  },
  statementBox: {
    margin: 0,
    padding: '10px 12px',
    fontSize: 12,
    lineHeight: 1.6,
    color: 'var(--text-primary)',
    background: 'var(--bg-primary)',
    border: '1px solid var(--accent-soft)',
    borderLeft: '3px solid var(--accent)',
    borderRadius: 2,
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'var(--font-mono)',
  },
  editArea: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    lineHeight: 1.6,
    color: 'var(--text-primary)',
    background: 'var(--bg-primary)',
    border: '1px solid var(--accent-soft)',
    borderLeft: '3px solid var(--accent)',
    borderRadius: 2,
    padding: '8px 10px',
    resize: 'vertical',
    minHeight: 140,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  reviewActions: {
    display: 'flex',
    gap: 8,
    flexShrink: 0,
  },
  btn: {
    border: 'none',
    borderRadius: 3,
    padding: '5px 14px',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'var(--font-display)',
    fontStyle: 'italic',
    fontWeight: 500,
    letterSpacing: '0.02em',
    transition: 'opacity 0.15s',
  },
  btnPrimary: {
    background: 'var(--accent)',
    color: 'var(--bg-ink)',
  },
  btnSecondary: {
    background: 'var(--bg-surface)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border-strong)',
  },
  btnDanger: {
    background: 'transparent',
    color: 'var(--vermillion)',
    border: '1px solid rgba(200,80,60,0.3)',
  },

  // ── Verified panel ───────────────────────────────────────────────────────
  verifiedPanel: {
    display: 'flex',
    flexDirection: 'column',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  verifiedBadge: {
    padding: '10px 14px 6px',
    fontSize: 11,
    lineHeight: 1.5,
    fontFamily: 'var(--font-display)',
    fontStyle: 'italic',
    color: 'var(--verdigris)',
    background: 'rgba(60,180,120,0.06)',
    borderBottom: '1px solid rgba(60,180,120,0.15)',
  },
  verifiedStatement: {
    margin: 0,
    padding: '12px 14px',
    fontSize: 12,
    lineHeight: 1.7,
    color: 'var(--text-primary)',
    background: 'var(--bg-primary)',
    borderLeft: '3px solid var(--verdigris)',
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
  },
};
