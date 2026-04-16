import React, { useMemo } from 'react';

/**
 * Theory Outline sidebar.
 * Shows all theorems, lemmas, definitions, etc. with:
 * - Type badges (color-coded)
 * - Proof status indicators
 * - Dependency information
 * - Click to navigate to source line
 */

const TYPE_LABELS = {
  theorem: 'Thm',
  lemma: 'Lem',
  proposition: 'Prop',
  corollary: 'Cor',
  definition: 'Def',
  example: 'Ex',
  remark: 'Rem',
  conjecture: 'Conj',
  claim: 'Clm',
  assumption: 'Asm',
  axiom: 'Ax',
  section: null, // rendered differently
};

// Typeset status marks — borrowed from math manuscript conventions.
//   \u220E (Halmos / QED)          — proved
//   \u2299 (circle with point)     — pending, waiting
//   \u22EF (horizontal ellipsis)   — proving, in flight
//   \u2297 (circled cross)         — failed
//   \u00B7 (middle dot)            — unproved, no intent yet
const STATUS_MARKS = {
  proved:   '\u220E',
  pending:  '\u2299',
  proving:  '\u22EF',
  failed:   '\u2297',
  unproved: '\u00B7',
};

function getProofStatus(node, proofTasks) {
  if (node.hasProof) return 'proved';
  if (!node.proveItMarker) return 'unproved';

  // Check if there's an active task for this node
  if (proofTasks) {
    for (const [, task] of proofTasks) {
      if (task.marker?.id === node.id) {
        if (task.status === 'running') return 'proving';
        if (task.status === 'completed') return 'proved';
        if (task.status === 'failed') return 'failed';
      }
    }
  }

  return 'pending'; // has marker, not yet submitted
}

function OutlineNode({ node, proofTasks, onClick, depth = 0 }) {
  const status = getProofStatus(node, proofTasks);

  if (node.type === 'section') {
    return (
      <div
        className="outline-node section"
        style={{ paddingLeft: 26 + depth * 12 }}
        onClick={() => onClick(node)}
      >
        <span style={{
          color: 'var(--accent-soft)',
          fontSize: 13,
          fontFamily: 'var(--font-display)',
          fontWeight: 500,
          width: 14,
          display: 'inline-block',
        }}>
          {node.sectionLevel === 'section' ? '§' :
           node.sectionLevel === 'subsection' ? '§§' : '§§§'}
        </span>
        <span>{node.name}</span>
      </div>
    );
  }

  const typeLabel = TYPE_LABELS[node.type] || node.type.toUpperCase().slice(0, 4);

  return (
    <div
      className="outline-node"
      style={{ paddingLeft: 14 + depth * 12 }}
      onClick={() => onClick(node)}
      title={`Line ${node.lineNumber} — ${node.labels?.join(', ') || 'no label'}`}
    >
      <span
        className="status-mark"
        data-status={status}
        title={status}
        aria-label={status}
      >
        {STATUS_MARKS[status] || STATUS_MARKS.unproved}
      </span>
      <span className={`type-badge ${node.type}`}>
        {typeLabel}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name || `(${node.type} ${node.lineNumber})`}
      </span>
      {node.proveItMarker && (
        <span className={`difficulty ${node.proveItMarker.difficulty}`}>
          {node.proveItMarker.difficulty.toLowerCase()}
        </span>
      )}
    </div>
  );
}

export default function TheoryOutline({ outline, proofTasks, onNodeClick, style }) {
  const stats = useMemo(() => {
    if (!outline?.nodes) return { total: 0, proved: 0, pending: 0, proving: 0 };
    const theoremNodes = outline.nodes.filter(n => n.type !== 'section');
    return {
      total: theoremNodes.length,
      proved: theoremNodes.filter(n => n.hasProof).length,
      pending: theoremNodes.filter(n => n.proveItMarker && !n.hasProof).length,
      proving: 0,
    };
  }, [outline]);

  return (
    <div className="sidebar" style={style}>
      <div className="sidebar-header">
        <span>Theorems &amp; lemmas</span>
        <span>
          {stats.proved} / {stats.total} <span style={{ color: 'var(--verdigris)', marginLeft: 2 }}>{'\u220E'}</span>
        </span>
      </div>
      <div className="sidebar-content">
        {outline?.nodes?.length > 0 ? (
          outline.nodes.map((node) => (
            <OutlineNode
              key={node.id}
              node={node}
              proofTasks={proofTasks}
              onClick={onNodeClick}
            />
          ))
        ) : (
          <div style={{
            padding: '40px 24px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 12.5,
            lineHeight: 1.6,
          }}>
            <div style={{
              fontFamily: 'var(--font-display)',
              fontStyle: 'italic',
              fontSize: 32,
              color: 'var(--text-faint)',
              marginBottom: 14,
              lineHeight: 1,
            }}>
              &nbsp;&nbsp;∴&nbsp;&nbsp;
            </div>
            <em style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
              No theorems yet.
            </em>
            <br />
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              Open a <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>.tex</code> file
              with <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>\begin&#123;theorem&#125;</code>
              &nbsp;environments.
            </span>
          </div>
        )}

        {outline?.edges?.length > 0 && (
          <div style={{
            padding: '14px 16px 8px 26px',
            borderTop: '1px solid var(--border-soft)',
            marginTop: 12,
          }}>
            <div style={{
              fontFamily: 'var(--font-display)',
              fontStyle: 'italic',
              fontSize: 11.5,
              color: 'var(--text-muted)',
              marginBottom: 8,
            }}>
              Cited within — {outline.edges.length}
            </div>
            {outline.edges.map((edge, i) => {
              const from = outline.nodes.find(n => n.id === edge.from);
              const to = outline.nodes.find(n => n.id === edge.to);
              return (
                <div key={i} style={{
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  padding: '3px 0',
                  lineHeight: 1.5,
                  fontFamily: 'var(--font-mono)',
                }}>
                  {from?.name || from?.type}
                  <span style={{ color: 'var(--accent-soft)', margin: '0 6px' }}>→</span>
                  {to?.name || to?.type}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
