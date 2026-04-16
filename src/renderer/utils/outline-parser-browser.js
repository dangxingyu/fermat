/**
 * Browser-side duplicate of the outline parser (for dev mode without Electron IPC).
 * Same logic as src/main/outline-parser.js — kept in sync.
 */

const THEOREM_ENVS = [
  'theorem', 'lemma', 'proposition', 'corollary',
  'definition', 'example', 'remark', 'conjecture', 'claim',
  'assumption', 'axiom', 'observation', 'fact',
];

const PROVE_IT_REGEX = /\[PROVE\s+IT:\s*(Easy|Medium|Hard)(?:\s*,\s*model\s*=\s*(\w+))?\]/gi;
const LABEL_REGEX = /\\label\{([^}]+)\}/g;
const REF_REGEX = /\\(?:ref|eqref|cref|Cref|autoref)\{([^}]+)\}/g;
const BEGIN_ENV_REGEX = /\\begin\{(\w+)\}(?:\[([^\]]*)\])?/;
const END_ENV_REGEX = /\\end\{(\w+)\}/;
const PROOF_BEGIN = /\\begin\{proof\}/;
const PROOF_END = /\\end\{proof\}/;
const SECTION_REGEX = /\\(section|subsection|subsubsection|chapter|part)\*?\{([^}]+)\}/;

export function parseTheoryOutlineBrowser(texContent) {
  const lines = texContent.split('\n');
  const nodes = [];
  const edges = [];
  const labelToNode = {};
  let currentEnv = null;
  let currentNode = null;
  let nodeIdCounter = 0;
  let insideProof = false;
  let proofForNode = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

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
      };
      nodes.push(node);
      let m;
      while ((m = LABEL_REGEX.exec(line)) !== null) {
        node.labels.push(m[1]);
        labelToNode[m[1]] = node.id;
      }
      LABEL_REGEX.lastIndex = 0;
      continue;
    }

    const beginMatch = line.match(BEGIN_ENV_REGEX);
    if (beginMatch && THEOREM_ENVS.includes(beginMatch[1].toLowerCase())) {
      currentEnv = beginMatch[1].toLowerCase();
      currentNode = {
        id: `node_${nodeIdCounter++}`,
        type: currentEnv,
        name: beginMatch[2] || '',
        lineNumber: lineNum,
        hasProof: false,
        proveItMarker: null,
        labels: [],
        refs: [],
        bodyLines: [],
      };
      continue;
    }

    const endMatch = line.match(END_ENV_REGEX);
    if (endMatch && currentEnv && endMatch[1].toLowerCase() === currentEnv) {
      if (currentNode) {
        const body = currentNode.bodyLines.join('\n');
        let m;
        while ((m = LABEL_REGEX.exec(body)) !== null) {
          currentNode.labels.push(m[1]);
          labelToNode[m[1]] = currentNode.id;
        }
        LABEL_REGEX.lastIndex = 0;
        while ((m = REF_REGEX.exec(body)) !== null) {
          currentNode.refs.push(m[1]);
        }
        REF_REGEX.lastIndex = 0;
        while ((m = PROVE_IT_REGEX.exec(body)) !== null) {
          currentNode.proveItMarker = {
            difficulty: m[1],
            preferredModel: m[2] || null,
            offset: m.index,
          };
        }
        PROVE_IT_REGEX.lastIndex = 0;
        delete currentNode.bodyLines;
        nodes.push(currentNode);
      }
      currentEnv = null;
      currentNode = null;
      continue;
    }

    if (currentNode) {
      currentNode.bodyLines.push(line);
    }

    if (PROOF_BEGIN.test(line)) {
      insideProof = true;
      const lastTheoremNode = [...nodes].reverse().find(
        n => THEOREM_ENVS.includes(n.type) && !n.hasProof
      );
      if (lastTheoremNode) proofForNode = lastTheoremNode;
    }
    if (PROOF_END.test(line) && proofForNode) {
      proofForNode.hasProof = true;
      insideProof = false;
      proofForNode = null;
    }

    if (!currentNode) {
      let m;
      while ((m = PROVE_IT_REGEX.exec(line)) !== null) {
        const lastNode = [...nodes].reverse().find(n => THEOREM_ENVS.includes(n.type));
        if (lastNode && !lastNode.proveItMarker) {
          lastNode.proveItMarker = {
            difficulty: m[1],
            preferredModel: m[2] || null,
            lineNumber: lineNum,
          };
        }
      }
      PROVE_IT_REGEX.lastIndex = 0;

      // User-provided sketch: `% SKETCH: ...` + continuation comment lines
      const sketchStart = line.match(/^\s*%\s*SKETCH\s*:\s*(.*)$/);
      if (sketchStart) {
        const sketchLines = [sketchStart[1].trim()];
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j];
          if (!next.trim()) break;
          const contMatch = next.match(/^\s*%\s*(.*)$/);
          if (!contMatch) break;
          if (/^\s*SKETCH\s*:/i.test(contMatch[1])) break;
          if (/\[PROVE\s+IT:/i.test(contMatch[1])) break;
          sketchLines.push(contMatch[1].trim());
          j++;
        }
        const lastTheoremNode = [...nodes].reverse().find(n =>
          THEOREM_ENVS.includes(n.type)
        );
        if (lastTheoremNode && !lastTheoremNode.userSketch) {
          lastTheoremNode.userSketch = sketchLines
            .filter(l => l.length > 0)
            .join(' ')
            .trim();
        }
        i = j - 1;
        continue;
      }
    }
  }

  for (const node of nodes) {
    if (!node.refs) continue;
    for (const ref of node.refs) {
      const targetNodeId = labelToNode[ref];
      if (targetNodeId && targetNodeId !== node.id) {
        edges.push({ from: node.id, to: targetNodeId, type: 'ref', label: ref });
      }
    }
  }

  return { nodes, edges };
}
