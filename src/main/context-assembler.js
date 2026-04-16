/**
 * ContextAssembler
 *
 * Builds rich, structured context for proof generation from the outline-parser output.
 *
 * Instead of sending a 20-line window around the marker, we assemble:
 *
 *   1. PREAMBLE     — packages, custom commands, theorem definitions
 *   2. THEORY MAP   — concise listing of all definitions/theorems/lemmas with status
 *   3. TARGET       — the full statement to be proved
 *   4. DEPENDENCIES — full statements of everything the target \ref's
 *   5. PROVED FACTS — proofs of dependencies (if already proved/accepted)
 *   6. FULL TEXT     — the complete document (models have big context windows, use them)
 *
 * The assembler also maintains a "proof memory" — proofs that have been accepted by
 * the user are stored and can be referenced by subsequent proof tasks.
 */

// P-04: LRU cap on proof memory — prevents context bloat on long sessions.
// After 40 accepted proofs, older entries are evicted. The prompt already
// formats only a handful of them per call so the cap is generous; its job
// is just to keep the Map from growing forever.
const PROOF_MEMORY_MAX = 40;

class ContextAssembler {
  constructor() {
    // proof memory: label -> { statementTeX, proofTeX, acceptedAt }
    // Map iteration order is insertion order, so delete+set moves an entry
    // to the "most recent" end — the standard Map-as-LRU trick.
    this.proofMemory = new Map();
  }

  /**
   * Record that a proof was accepted by the user.
   * Future proof tasks can reference this as a known result.
   */
  recordAcceptedProof(label, statementTeX, proofTeX) {
    // LRU: if the label is already present, delete first so set() re-inserts
    // at the end (most-recent position).
    if (this.proofMemory.has(label)) this.proofMemory.delete(label);
    this.proofMemory.set(label, {
      statementTeX,
      proofTeX,
      acceptedAt: Date.now(),
    });
    // Evict oldest entries once we exceed the cap (P-04)
    while (this.proofMemory.size > PROOF_MEMORY_MAX) {
      const oldestKey = this.proofMemory.keys().next().value;
      this.proofMemory.delete(oldestKey);
    }
  }

  /**
   * Assemble full context for a proof task.
   *
   * @param {object} outline   — output of parseTheoryOutline()
   * @param {object} targetNode — the node to prove (from outline.nodes)
   * @returns {object} structured context
   */
  assembleForProof(outline, targetNode) {
    const { nodes, edges, preamble, theoremStyles, labelToNode, fullText } = outline;

    // ─── 1. Theory map: concise summary of the whole document ───
    const theoryMap = this._buildTheoryMap(nodes);

    // ─── 2. Resolve direct dependencies (things the target \ref's) ───
    const directDeps = this._resolveDependencies(targetNode, nodes, labelToNode);

    // ─── 3. Resolve transitive dependencies (deps of deps, 1 level deep) ───
    const transitiveDeps = [];
    for (const dep of directDeps) {
      const depDeps = this._resolveDependencies(dep, nodes, labelToNode);
      for (const dd of depDeps) {
        if (dd.id !== targetNode.id && !directDeps.find(d => d.id === dd.id)
            && !transitiveDeps.find(t => t.id === dd.id)) {
          transitiveDeps.push(dd);
        }
      }
    }

    // ─── 4. Collect proof memory for dependencies ───
    const knownProofs = [];
    for (const dep of [...directDeps, ...transitiveDeps]) {
      for (const label of (dep.labels || [])) {
        if (this.proofMemory.has(label)) {
          knownProofs.push({
            label,
            name: dep.name || dep.type,
            ...this.proofMemory.get(label),
          });
        }
      }
      // Also include proofs from the document itself
      if (dep.hasProof && dep.proofTeX) {
        knownProofs.push({
          label: dep.labels?.[0] || dep.id,
          name: dep.name || dep.type,
          statementTeX: dep.statementTeX,
          proofTeX: dep.proofTeX,
        });
      }
    }

    // ─── 5. Build the structured context object ───
    return {
      preamble,
      theoremStyles,

      theoryMap,

      target: {
        id: targetNode.id,
        type: targetNode.type,
        name: targetNode.name,
        labels: targetNode.labels,
        statementTeX: targetNode.statementTeX,
        difficulty: targetNode.proveItMarker?.difficulty || 'Medium',
        lineNumber: targetNode.lineNumber,
        userSketch: targetNode.userSketch || null,
      },

      directDependencies: directDeps.map(d => ({
        type: d.type,
        name: d.name,
        labels: d.labels,
        statementTeX: d.statementTeX,
        hasProof: d.hasProof,
      })),

      transitiveDependencies: transitiveDeps.map(d => ({
        type: d.type,
        name: d.name,
        labels: d.labels,
        statementTeX: d.statementTeX,
        hasProof: d.hasProof,
      })),

      knownProofs,

      fullText,
    };
  }

  /**
   * Format the assembled context as a prompt string.
   * This is what gets sent to the model.
   */
  formatAsPrompt(ctx) {
    const sections = [];

    // Preamble
    if (ctx.preamble) {
      sections.push(`<preamble>\n${ctx.preamble}\n</preamble>`);
    }

    // Theory map
    sections.push(`<theory_map>\n${ctx.theoryMap}\n</theory_map>`);

    // Target
    sections.push(`<target difficulty="${ctx.target.difficulty}">
Type: ${ctx.target.type}
Name: ${ctx.target.name || '(unnamed)'}
Labels: ${ctx.target.labels?.join(', ') || '(none)'}

${ctx.target.statementTeX}
</target>`);

    // User-provided sketch (author's hint, if present)
    if (ctx.target.userSketch) {
      sections.push(`<user_sketch>
The author has provided the following hint about how to approach the proof. It may be vague (one phrase), partial (covering only part of the claim), detailed, or occasionally incorrect. Read it to understand the author's preferred direction, but rely on <proof_sketch> (if present) for the concrete plan — the sketch skill has already elaborated this hint into a full strategy. Preserve the author's choice of technique when it is reasonable; extend beyond it when the claim requires more than the hint covers.

${ctx.target.userSketch}
</user_sketch>`);
    }

    // Direct dependencies
    if (ctx.directDependencies.length > 0) {
      const deps = ctx.directDependencies.map(d =>
        `[${d.type}] ${d.name || '(unnamed)'} (${d.labels?.join(', ') || 'no label'}) — ${d.hasProof ? 'PROVED' : 'UNPROVED'}\n${d.statementTeX}`
      ).join('\n\n');
      sections.push(`<direct_dependencies>\n${deps}\n</direct_dependencies>`);
    }

    // Transitive dependencies
    if (ctx.transitiveDependencies.length > 0) {
      const deps = ctx.transitiveDependencies.map(d =>
        `[${d.type}] ${d.name || '(unnamed)'} (${d.labels?.join(', ') || 'no label'}) — ${d.hasProof ? 'PROVED' : 'UNPROVED'}\n${d.statementTeX}`
      ).join('\n\n');
      sections.push(`<transitive_dependencies>\n${deps}\n</transitive_dependencies>`);
    }

    // Known proofs
    if (ctx.knownProofs.length > 0) {
      const proofs = ctx.knownProofs.map(p =>
        `── ${p.name} (${p.label}) ──\nStatement:\n${p.statementTeX}\nProof:\n${p.proofTeX}`
      ).join('\n\n');
      sections.push(`<known_proofs>\n${proofs}\n</known_proofs>`);
    }

    // Full document
    sections.push(`<full_document>\n${ctx.fullText}\n</full_document>`);

    return sections.join('\n\n');
  }

  // ─── Internal helpers ─────────────────────────────────────────

  _buildTheoryMap(nodes) {
    const lines = [];
    for (const node of nodes) {
      if (node.type === 'section') {
        lines.push(`\n## ${node.name}`);
        continue;
      }
      const status = node.hasProof ? '✓' : (node.proveItMarker ? '⟳' : '○');
      const label = node.labels?.[0] ? ` (${node.labels[0]})` : '';
      const name = node.name ? `: ${node.name}` : '';
      lines.push(`  ${status} [${node.type}${name}]${label} — line ${node.lineNumber}`);
    }
    return lines.join('\n');
  }

  _resolveDependencies(node, allNodes, labelToNode) {
    const deps = [];
    if (!node.refs) return deps;
    for (const ref of node.refs) {
      const targetNodeId = labelToNode[ref];
      if (!targetNodeId || targetNodeId === node.id) continue;
      const targetNode = allNodes.find(n => n.id === targetNodeId);
      if (targetNode && !deps.find(d => d.id === targetNode.id)) {
        deps.push(targetNode);
      }
    }
    return deps;
  }
}

module.exports = { ContextAssembler };
