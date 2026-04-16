/**
 * OutlineParser
 *
 * Parses LaTeX source to extract a structured theory outline:
 * - Theorems, Lemmas, Propositions, Corollaries, Definitions, Remarks
 * - Detects \label{} and \ref{} to build a dependency graph
 * - Detects [PROVE IT: X] markers and their status
 * - Extracts preamble (everything before \begin{document})
 * - Preserves full statement text and proof text for each node
 * - Extracts custom command/environment definitions from preamble
 *
 * Output: { nodes, edges, preamble, customCommands, fullText }
 *   node: { id, type, label, name, lineNumber, hasProof, proveItMarker,
 *           statementTeX, proofTeX, labels, refs, endLineNumber }
 *   edge: { from, to, type }  (type: 'ref' | 'depends')
 */

const THEOREM_ENVS = [
  'theorem', 'lemma', 'proposition', 'corollary',
  'definition', 'example', 'remark', 'conjecture', 'claim',
  'assumption', 'axiom', 'observation', 'fact',
];

// B-08/Q-04: Stateful regexes with the `g` flag are dangerous at module scope —
// `lastIndex` leaks across calls if any call throws mid-loop. We store the
// source strings + flags and build fresh RegExp instances inside the parser
// function, and for iteration we use `matchAll()` (which doesn't mutate the
// regex's lastIndex) so exception paths can't poison subsequent parses.
const PROVE_IT_SRC = [String.raw`\[PROVE\s+IT:\s*(Easy|Medium|Hard)(?:\s*,\s*model\s*=\s*(\w+))?\]`, 'gi'];
const LABEL_SRC    = [String.raw`\\label\{([^}]+)\}`,                                                   'g'];
const REF_SRC      = [String.raw`\\(?:ref|eqref|cref|Cref|autoref)\{([^}]+)\}`,                         'g'];
const BEGIN_ENV_REGEX = /\\begin\{(\w+)\}(?:\[([^\]]*)\])?/;
const END_ENV_REGEX = /\\end\{(\w+)\}/;
const PROOF_BEGIN = /\\begin\{proof\}/;
const PROOF_END = /\\end\{proof\}/;
const SECTION_REGEX = /\\(section|subsection|subsubsection|chapter|part)\*?\{([^}]+)\}/;

const reProveIt = () => new RegExp(PROVE_IT_SRC[0], PROVE_IT_SRC[1]);
const reLabel   = () => new RegExp(LABEL_SRC[0],    LABEL_SRC[1]);
const reRef     = () => new RegExp(REF_SRC[0],      REF_SRC[1]);

function parseTheoryOutline(texContent) {
  const lines = texContent.split('\n');
  const nodes = [];
  const edges = [];
  const labelToNode = {};  // label string -> node id
  let currentEnv = null;
  let currentNode = null;
  let nodeIdCounter = 0;
  let insideProof = false;
  let proofForNode = null;
  let proofLines = [];

  // ─── Extract preamble (everything before \begin{document}) ───
  let preamble = '';
  let documentBodyStart = 0;
  const customCommands = [];  // { command, definition, lineNumber }

  for (let i = 0; i < lines.length; i++) {
    if (/\\begin\{document\}/.test(lines[i])) {
      preamble = lines.slice(0, i).join('\n');
      documentBodyStart = i + 1;
      break;
    }
  }

  // Extract custom commands and theorem definitions from preamble
  const CMD_REGEX = /\\(?:newcommand|renewcommand|DeclareMathOperator|def)\s*\{?\\(\w+)\}?/g;
  const NEWTHM_REGEX = /\\newtheorem\*?\{(\w+)\}(?:\[(\w+)\])?\{([^}]+)\}/g;
  let m;
  while ((m = CMD_REGEX.exec(preamble)) !== null) {
    customCommands.push({ command: m[1], line: preamble.substring(0, m.index).split('\n').length });
  }
  const theoremStyles = {};
  while ((m = NEWTHM_REGEX.exec(preamble)) !== null) {
    theoremStyles[m[1]] = { counter: m[2] || null, printName: m[3] };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // ─── Section headings ───
    const sectionMatch = line.match(SECTION_REGEX);
    if (sectionMatch) {
      const node = {
        id: `node_${nodeIdCounter++}`,
        type: 'section',
        sectionLevel: sectionMatch[1],
        name: sectionMatch[2].trim(),
        lineNumber: lineNum,
        hasProof: false,
        proveItMarker: null,
        labels: [],
        refs: [],
        statementTeX: '',
      };
      nodes.push(node);
      for (const lm of line.matchAll(reLabel())) {
        node.labels.push(lm[1]);
        labelToNode[lm[1]] = node.id;
      }
      continue;
    }

    // ─── Begin theorem-like environment ───
    const beginMatch = line.match(BEGIN_ENV_REGEX);
    if (beginMatch && THEOREM_ENVS.includes(beginMatch[1].toLowerCase())) {
      currentEnv = beginMatch[1].toLowerCase();
      currentNode = {
        id: `node_${nodeIdCounter++}`,
        type: currentEnv,
        name: beginMatch[2] || '',  // optional [Name]
        lineNumber: lineNum,
        endLineNumber: null,
        hasProof: false,
        proveItMarker: null,
        labels: [],
        refs: [],
        _bodyLines: [],       // internal, stripped before output
        _beginLine: line,     // preserve the \begin line for full statement
        statementTeX: '',     // full statement including \begin..\end
        proofTeX: '',         // filled if a proof follows
      };
      continue;
    }

    // ─── End theorem-like environment ───
    const endMatch = line.match(END_ENV_REGEX);
    if (endMatch && currentEnv && endMatch[1].toLowerCase() === currentEnv) {
      if (currentNode) {
        currentNode.endLineNumber = lineNum;

        // Build full statement TeX
        currentNode.statementTeX = [
          currentNode._beginLine,
          ...currentNode._bodyLines,
          line,
        ].join('\n');

        // Extract labels from body
        const body = currentNode._bodyLines.join('\n');
        for (const lm of body.matchAll(reLabel())) {
          currentNode.labels.push(lm[1]);
          labelToNode[lm[1]] = currentNode.id;
        }

        // Extract refs from body
        for (const lm of body.matchAll(reRef())) {
          currentNode.refs.push(lm[1]);
        }

        // Check for PROVE IT markers in body
        for (const lm of body.matchAll(reProveIt())) {
          currentNode.proveItMarker = {
            difficulty: lm[1],
            preferredModel: lm[2] || null,
            offset: lm.index,
          };
        }

        // ─── Fallback display name for unnamed nodes ───
        // Many real documents write `\begin{corollary}` without `[Name]`.
        // Previously we fell back to "(corollary 52)" which reads as a bug.
        // Prefer, in order:
        //   1. the first label (e.g. "cor:sqrt2")
        //   2. the first ~60 chars of statement body (cleaned)
        //   3. a Title-Cased env name ("Corollary")
        if (!currentNode.name || !currentNode.name.trim()) {
          if (currentNode.labels.length > 0) {
            currentNode.name = currentNode.labels[0];
          } else {
            const firstLine = currentNode._bodyLines
              .map(l => l.trim())
              .find(l => l && !l.startsWith('%') && !l.startsWith('\\label'));
            if (firstLine) {
              const cleaned = firstLine
                .replace(/\\(?:label|ref|eqref|cite|cref|Cref|autoref)\{[^}]*\}/g, '')
                .replace(/\$[^$]*\$/g, '·')      // collapse inline math to a dot
                .replace(/\\[a-zA-Z]+\*?/g, '')  // strip macros
                .replace(/[{}]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
              currentNode.name = cleaned.length > 60
                ? cleaned.slice(0, 57).trimEnd() + '…'
                : cleaned;
            }
            if (!currentNode.name) {
              currentNode.name = currentEnv.charAt(0).toUpperCase() + currentEnv.slice(1);
            }
          }
        }

        // Clean up internal fields
        delete currentNode._bodyLines;
        delete currentNode._beginLine;
        nodes.push(currentNode);
      }
      currentEnv = null;
      currentNode = null;
      continue;
    }

    // ─── Accumulate body lines ───
    if (currentNode) {
      currentNode._bodyLines.push(line);
    }

    // ─── Track proof environments + capture proof text ───
    if (PROOF_BEGIN.test(line)) {
      insideProof = true;
      proofLines = [line];
      // Associate proof with the most recent theorem-like node
      const lastTheoremNode = [...nodes].reverse().find(
        n => THEOREM_ENVS.includes(n.type) && !n.hasProof
      );
      if (lastTheoremNode) {
        proofForNode = lastTheoremNode;
      }
    } else if (insideProof) {
      proofLines.push(line);
    }

    if (PROOF_END.test(line) && proofForNode) {
      proofForNode.hasProof = true;
      proofForNode.proofTeX = proofLines.join('\n');
      insideProof = false;
      proofForNode = null;
      proofLines = [];
    }

    // ─── Standalone PROVE IT markers (outside theorem envs) ───
    if (!currentNode) {
      for (const pm of line.matchAll(reProveIt())) {
        const lastNode = [...nodes].reverse().find(n => THEOREM_ENVS.includes(n.type));
        if (lastNode && !lastNode.proveItMarker) {
          lastNode.proveItMarker = {
            difficulty: pm[1],
            preferredModel: pm[2] || null,
            lineNumber: lineNum,
          };
        }
      }

      // ─── User-provided proof sketch ───
      // Format:
      //   % SKETCH: First idea here...
      //   %   continuation line 1
      //   %   continuation line 2
      // Followed by any non-% line (or blank/comment-less line) to end.
      const sketchStart = line.match(/^\s*%\s*SKETCH\s*:\s*(.*)$/);
      if (sketchStart) {
        const sketchLines = [sketchStart[1].trim()];
        // Consume continuation lines
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j];
          // Stop on blank line, non-comment line, or a new marker-like comment
          if (!next.trim()) break;
          const contMatch = next.match(/^\s*%\s*(.*)$/);
          if (!contMatch) break;
          // Stop if the next comment is itself a SKETCH: or PROVE IT marker
          if (/^\s*SKETCH\s*:/i.test(contMatch[1])) break;
          if (/\[PROVE\s+IT:/i.test(contMatch[1])) break;
          sketchLines.push(contMatch[1].trim());
          j++;
        }
        // Attach to the nearest preceding theorem-like node
        const lastTheoremNode = [...nodes].reverse().find(n =>
          THEOREM_ENVS.includes(n.type)
        );
        if (lastTheoremNode && !lastTheoremNode.userSketch) {
          lastTheoremNode.userSketch = sketchLines
            .filter(l => l.length > 0)
            .join(' ')
            .trim();
        }
        // Advance outer loop past the consumed lines
        i = j - 1;
        continue;
      }
    }

    // Also check same-line labels outside envs
    if (!currentNode) {
      for (const lm of line.matchAll(reLabel())) {
        const lastNode = nodes[nodes.length - 1];
        if (lastNode && !lastNode.labels?.includes(lm[1])) {
          lastNode.labels = lastNode.labels || [];
          lastNode.labels.push(lm[1]);
          labelToNode[lm[1]] = lastNode.id;
        }
      }
    }
  }

  // ─── Build dependency edges from refs ───
  for (const node of nodes) {
    if (!node.refs) continue;
    for (const ref of node.refs) {
      const targetNodeId = labelToNode[ref];
      if (targetNodeId && targetNodeId !== node.id) {
        edges.push({
          from: node.id,
          to: targetNodeId,
          type: 'ref',
          label: ref,
        });
      }
    }
  }

  return {
    nodes,
    edges,
    preamble,
    customCommands,
    theoremStyles,
    labelToNode,
    fullText: texContent,
  };
}

module.exports = { parseTheoryOutline };
