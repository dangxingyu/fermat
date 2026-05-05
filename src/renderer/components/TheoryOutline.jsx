import { useMemo, useState } from 'react';
import { countCopilotNotes } from '../utils/outline-audit-browser';

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

function AuditStatus({ status, error, onRefresh }) {
  const label = {
    waiting: 'queued',
    loading: 'loading',
    auditing: 'auditing',
    ready: 'audited',
    stale: 'stale',
    failed: 'failed',
  }[status] || '';

  if (!label && !onRefresh) return null;

  return (
    <span className={`outline-audit-status ${status || 'idle'}`} title={error || label}>
      {label && <span>{label}</span>}
      {onRefresh && (
        <button
          type="button"
          className="outline-audit-refresh"
          onClick={(event) => {
            event.stopPropagation();
            onRefresh();
          }}
          title="Refresh semantic audit"
          aria-label="Refresh semantic audit"
        >
          ↻
        </button>
      )}
    </span>
  );
}

function NoteGroup({ title, items, empty, renderItem }) {
  return (
    <div className="copilot-note-group">
      <div className="copilot-note-title">{title}</div>
      {items.length > 0 ? (
        <div className="copilot-note-list">
          {items.map((item, index) => (
            <div className="copilot-note-item" key={`${title}-${index}`}>
              {renderItem(item)}
            </div>
          ))}
        </div>
      ) : (
        <div className="copilot-note-empty">{empty}</div>
      )}
    </div>
  );
}

function PolicyTag({ value }) {
  if (!value) return null;
  return <span className={`policy-tag ${value}`}>{value}</span>;
}

function CopilotNotes({ node, citedNodes }) {
  const copilot = node.copilot || {};
  const warnings = [...(copilot.warnings || [])];
  if (copilot.status === 'stale') {
    warnings.unshift({
      statement: 'Audit is stale for this statement.',
      reason: 'The statement hash no longer matches the saved audit entry.',
    });
  }

  return (
    <div className={`copilot-notes ${copilot.status === 'stale' ? 'stale' : ''}`}>
      <div className="copilot-notes-header">
        <span>Copilot notes</span>
        {copilot.status && <span>{copilot.status}</span>}
      </div>
      <NoteGroup
        title="Cited"
        items={citedNodes}
        empty="No explicit citations."
        renderItem={(item) => (
          <>
            <span className="note-main">{item.target?.name || item.label}</span>
            <span className="note-meta">{item.target?.labels?.[0] || item.label}</span>
          </>
        )}
      />
      <NoteGroup
        title="Suggested"
        items={copilot.suggestedDependencies || []}
        empty="No semantic dependency suggestions."
        renderItem={(item) => (
          <>
            <span className="note-main">{item.statement || item.targetLabel}</span>
            <span className="note-meta">
              {item.targetLabel || item.confidence}
              <PolicyTag value={item.usePolicy} />
            </span>
            {item.reason && <span className="note-reason">{item.reason}</span>}
          </>
        )}
      />
      <NoteGroup
        title="Source-backed"
        items={copilot.sourceBackedFacts || []}
        empty="No source-backed facts attached."
        renderItem={(item) => (
          <>
            <span className="note-main">{item.statement}</span>
            <span className="note-meta">
              {item.sourceRef || item.sourceId}
              <PolicyTag value={item.usePolicy} />
            </span>
            {item.conditionMatch && <span className="note-reason">{item.conditionMatch}</span>}
          </>
        )}
      />
      <NoteGroup
        title="Obligations"
        items={copilot.proofObligations || []}
        empty="No proof obligations recorded."
        renderItem={(item) => (
          <>
            <span className="note-main">{item.statement}</span>
            <span className="note-meta">
              {item.confidence}
              <PolicyTag value={item.usePolicy} />
            </span>
            {item.neededFor && <span className="note-reason">{item.neededFor}</span>}
          </>
        )}
      />
      <NoteGroup
        title="Warnings"
        items={[...(copilot.missingCitations || []), ...warnings]}
        empty="No warnings."
        renderItem={(item) => (
          <>
            <span className="note-main">{item.statement || item.reason}</span>
            <span className="note-meta">
              {item.suggestedLabel || item.tier || item.confidence}
              <PolicyTag value={item.usePolicy} />
            </span>
            {item.reason && <span className="note-reason">{item.reason}</span>}
          </>
        )}
      />
    </div>
  );
}

function CopilotBadges({ copilot }) {
  const counts = countCopilotNotes(copilot);
  if (!counts.total) return null;
  return (
    <span className="copilot-badges" aria-label="Copilot annotations">
      {counts.suggested > 0 && <span className="copilot-badge suggested">+{counts.suggested}</span>}
      {counts.missing > 0 && <span className="copilot-badge missing">c{counts.missing}</span>}
      {counts.sources > 0 && <span className="copilot-badge sources">s{counts.sources}</span>}
      {counts.obligations > 0 && <span className="copilot-badge obligations">!{counts.obligations}</span>}
      {counts.warnings > 0 && <span className="copilot-badge warnings">?{counts.warnings}</span>}
    </span>
  );
}

function OutlineNode({ node, proofTasks, onClick, citedNodes, expanded, onToggle, depth = 0 }) {
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
    <div className="outline-node-wrap">
      <div
        className={`outline-node ${expanded ? 'expanded' : ''}`}
        style={{ paddingLeft: 14 + depth * 12 }}
        onClick={() => {
          onClick(node);
          onToggle(node.id);
        }}
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
        <span className="outline-node-title">
          {node.name || `(${node.type} ${node.lineNumber})`}
        </span>
        <CopilotBadges copilot={node.copilot} />
        {node.proveItMarker && (
          <span className={`effort ${node.proveItMarker.effort}`}>
            {node.proveItMarker.effort}
          </span>
        )}
      </div>
      {expanded && (
        <CopilotNotes node={node} citedNodes={citedNodes} />
      )}
    </div>
  );
}

export default function TheoryOutline({
  outline,
  proofTasks,
  auditStatus,
  auditError,
  onRefreshAudit,
  onNodeClick,
  style,
}) {
  const [expandedNodeId, setExpandedNodeId] = useState(null);
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

  const citedByNode = useMemo(() => {
    const map = new Map();
    for (const edge of outline?.edges || []) {
      const from = outline.nodes.find(n => n.id === edge.from);
      const target = outline.nodes.find(n => n.id === edge.to);
      if (!from) continue;
      if (!map.has(from.id)) map.set(from.id, []);
      map.get(from.id).push({ label: edge.label, target });
    }
    return map;
  }, [outline]);

  return (
    <div className="sidebar" style={style}>
      <div className="sidebar-header">
        <span>Theorems &amp; lemmas</span>
        <span className="sidebar-header-right">
          <AuditStatus status={auditStatus} error={auditError} onRefresh={onRefreshAudit} />
          <span>
            {stats.proved} / {stats.total} <span style={{ color: 'var(--verdigris)', marginLeft: 2 }}>{'\u220E'}</span>
          </span>
        </span>
      </div>
      <div className="sidebar-content">
        {outline?.nodes?.length > 0 ? (
          outline.nodes.map((node) => (
            <OutlineNode
              key={node.id}
              node={node}
              proofTasks={proofTasks}
              citedNodes={citedByNode.get(node.id) || []}
              expanded={expandedNodeId === node.id}
              onToggle={(nodeId) => setExpandedNodeId(prev => (prev === nodeId ? null : nodeId))}
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
      </div>
    </div>
  );
}
