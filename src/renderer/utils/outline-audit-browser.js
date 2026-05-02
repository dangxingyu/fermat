function firstLabel(node) {
  return node?.labels?.[0] || '';
}

function findAuditNode(node, auditNodes) {
  if (!node || node.type === 'section') return null;

  const label = firstLabel(node);
  if (label) {
    const byLabel = auditNodes.find(item => item.nodeKey === `label:${label}` || item.labels?.includes(label));
    if (byLabel) return byLabel;
  }

  return auditNodes.find(item =>
    !firstLabel(node) &&
    item.lineNumber === node.lineNumber &&
    item.type === node.type
  ) || null;
}

function withFreshness(node, copilot) {
  if (!copilot) return null;
  const stale = node?.statementHash && copilot.statementHash &&
    node.statementHash !== copilot.statementHash;
  return stale ? { ...copilot, status: 'stale' } : copilot;
}

export function annotateOutlineWithAudit(outline, audit) {
  if (!outline?.nodes || !audit?.nodes) return outline || { nodes: [], edges: [] };

  const auditNodes = Object.values(audit.nodes || {});
  return {
    ...outline,
    audit,
    nodes: outline.nodes.map(node => {
      const copilot = withFreshness(node, findAuditNode(node, auditNodes));
      return copilot ? { ...node, copilot } : node;
    }),
  };
}

export function countCopilotNotes(copilot) {
  if (!copilot) {
    return { suggested: 0, missing: 0, obligations: 0, warnings: 0, total: 0 };
  }
  const suggested = copilot.suggestedDependencies?.length || 0;
  const missing = copilot.missingCitations?.length || 0;
  const obligations = copilot.proofObligations?.length || 0;
  const warnings = (copilot.warnings?.length || 0) + (copilot.status === 'stale' ? 1 : 0);
  return {
    suggested,
    missing,
    obligations,
    warnings,
    total: suggested + missing + obligations + warnings,
  };
}
