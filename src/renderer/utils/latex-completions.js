/**
 * Fermat — LaTeX Intelligent Completion Provider
 *
 * Features:
 *   1. Command completion (\frac, \textbf, \int, etc.) with snippet tab-stops
 *   2. Environment auto-close: \begin{env} → auto-insert \end{env}
 *   3. Smart \item insertion for list environments
 *   4. Math symbol completion
 *   5. Package-aware completions
 *   6. \ref{} and \cite{} label completion from document
 */

// ─── LaTeX Command Snippets ──────────────────────────────────────────
// Format: { label, insertText (snippet syntax), detail, documentation }

const SECTION_COMMANDS = [
  { label: '\\part', insertText: '\\part{${1:title}}', detail: 'Part heading' },
  { label: '\\chapter', insertText: '\\chapter{${1:title}}', detail: 'Chapter heading' },
  { label: '\\section', insertText: '\\section{${1:title}}', detail: 'Section heading' },
  { label: '\\subsection', insertText: '\\subsection{${1:title}}', detail: 'Subsection heading' },
  { label: '\\subsubsection', insertText: '\\subsubsection{${1:title}}', detail: 'Subsubsection heading' },
  { label: '\\paragraph', insertText: '\\paragraph{${1:title}}', detail: 'Paragraph heading' },
];

const TEXT_COMMANDS = [
  { label: '\\textbf', insertText: '\\textbf{${1:text}}', detail: 'Bold text' },
  { label: '\\textit', insertText: '\\textit{${1:text}}', detail: 'Italic text' },
  { label: '\\texttt', insertText: '\\texttt{${1:text}}', detail: 'Monospace text' },
  { label: '\\textsc', insertText: '\\textsc{${1:text}}', detail: 'Small caps' },
  { label: '\\underline', insertText: '\\underline{${1:text}}', detail: 'Underlined text' },
  { label: '\\emph', insertText: '\\emph{${1:text}}', detail: 'Emphasized text' },
  { label: '\\textrm', insertText: '\\textrm{${1:text}}', detail: 'Roman text' },
  { label: '\\textsf', insertText: '\\textsf{${1:text}}', detail: 'Sans-serif text' },
  { label: '\\footnote', insertText: '\\footnote{${1:text}}', detail: 'Footnote' },
  { label: '\\href', insertText: '\\href{${1:url}}{${2:text}}', detail: 'Hyperlink' },
  { label: '\\url', insertText: '\\url{${1:url}}', detail: 'URL' },
  { label: '\\color', insertText: '\\color{${1:color}}{${2:text}}', detail: 'Colored text' },
];

const MATH_COMMANDS = [
  { label: '\\frac', insertText: '\\frac{${1:num}}{${2:den}}', detail: 'Fraction' },
  { label: '\\dfrac', insertText: '\\dfrac{${1:num}}{${2:den}}', detail: 'Display fraction' },
  { label: '\\tfrac', insertText: '\\tfrac{${1:num}}{${2:den}}', detail: 'Text fraction' },
  { label: '\\sqrt', insertText: '\\sqrt{${1:expr}}', detail: 'Square root' },
  { label: '\\sqrt[n]', insertText: '\\sqrt[${1:n}]{${2:expr}}', detail: 'Nth root' },
  { label: '\\sum', insertText: '\\sum_{${1:i=1}}^{${2:n}}', detail: 'Summation' },
  { label: '\\prod', insertText: '\\prod_{${1:i=1}}^{${2:n}}', detail: 'Product' },
  { label: '\\int', insertText: '\\int_{${1:a}}^{${2:b}} ${3:f(x)} \\, dx', detail: 'Integral' },
  { label: '\\iint', insertText: '\\iint_{${1:D}} ${2:f} \\, dA', detail: 'Double integral' },
  { label: '\\iiint', insertText: '\\iiint_{${1:V}} ${2:f} \\, dV', detail: 'Triple integral' },
  { label: '\\oint', insertText: '\\oint_{${1:C}} ${2:f} \\, ds', detail: 'Contour integral' },
  { label: '\\lim', insertText: '\\lim_{${1:x \\to \\infty}}', detail: 'Limit' },
  { label: '\\limsup', insertText: '\\limsup_{${1:n \\to \\infty}}', detail: 'Limit superior' },
  { label: '\\liminf', insertText: '\\liminf_{${1:n \\to \\infty}}', detail: 'Limit inferior' },
  { label: '\\sup', insertText: '\\sup_{${1:x \\in S}}', detail: 'Supremum' },
  { label: '\\inf', insertText: '\\inf_{${1:x \\in S}}', detail: 'Infimum' },
  { label: '\\max', insertText: '\\max_{${1:x}}', detail: 'Maximum' },
  { label: '\\min', insertText: '\\min_{${1:x}}', detail: 'Minimum' },
  { label: '\\binom', insertText: '\\binom{${1:n}}{${2:k}}', detail: 'Binomial coefficient' },
  { label: '\\overline', insertText: '\\overline{${1:expr}}', detail: 'Overline' },
  { label: '\\underline', insertText: '\\underline{${1:expr}}', detail: 'Underline (math)' },
  { label: '\\hat', insertText: '\\hat{${1:x}}', detail: 'Hat accent' },
  { label: '\\tilde', insertText: '\\tilde{${1:x}}', detail: 'Tilde accent' },
  { label: '\\bar', insertText: '\\bar{${1:x}}', detail: 'Bar accent' },
  { label: '\\vec', insertText: '\\vec{${1:x}}', detail: 'Vector accent' },
  { label: '\\dot', insertText: '\\dot{${1:x}}', detail: 'Dot accent' },
  { label: '\\ddot', insertText: '\\ddot{${1:x}}', detail: 'Double dot accent' },
  { label: '\\mathbb', insertText: '\\mathbb{${1:R}}', detail: 'Blackboard bold' },
  { label: '\\mathcal', insertText: '\\mathcal{${1:A}}', detail: 'Calligraphic' },
  { label: '\\mathfrak', insertText: '\\mathfrak{${1:g}}', detail: 'Fraktur' },
  { label: '\\mathrm', insertText: '\\mathrm{${1:text}}', detail: 'Roman in math' },
  { label: '\\mathbf', insertText: '\\mathbf{${1:x}}', detail: 'Bold math' },
  { label: '\\text', insertText: '\\text{${1:text}}', detail: 'Text in math mode' },
  { label: '\\operatorname', insertText: '\\operatorname{${1:name}}', detail: 'Custom operator' },
  { label: '\\underbrace', insertText: '\\underbrace{${1:expr}}_{${2:label}}', detail: 'Underbrace' },
  { label: '\\overbrace', insertText: '\\overbrace{${1:expr}}^{${2:label}}', detail: 'Overbrace' },
  { label: '\\stackrel', insertText: '\\stackrel{${1:top}}{${2:bottom}}', detail: 'Stacked relation' },
  { label: '\\xrightarrow', insertText: '\\xrightarrow{${1:text}}', detail: 'Extensible right arrow' },
  { label: '\\xleftarrow', insertText: '\\xleftarrow{${1:text}}', detail: 'Extensible left arrow' },
];

const MATH_SYMBOLS = [
  // Greek letters
  { label: '\\alpha', detail: 'α' }, { label: '\\beta', detail: 'β' },
  { label: '\\gamma', detail: 'γ' }, { label: '\\Gamma', detail: 'Γ' },
  { label: '\\delta', detail: 'δ' }, { label: '\\Delta', detail: 'Δ' },
  { label: '\\epsilon', detail: 'ε' }, { label: '\\varepsilon', detail: 'ε (variant)' },
  { label: '\\zeta', detail: 'ζ' }, { label: '\\eta', detail: 'η' },
  { label: '\\theta', detail: 'θ' }, { label: '\\Theta', detail: 'Θ' },
  { label: '\\vartheta', detail: 'ϑ' },
  { label: '\\iota', detail: 'ι' }, { label: '\\kappa', detail: 'κ' },
  { label: '\\lambda', detail: 'λ' }, { label: '\\Lambda', detail: 'Λ' },
  { label: '\\mu', detail: 'μ' }, { label: '\\nu', detail: 'ν' },
  { label: '\\xi', detail: 'ξ' }, { label: '\\Xi', detail: 'Ξ' },
  { label: '\\pi', detail: 'π' }, { label: '\\Pi', detail: 'Π' },
  { label: '\\rho', detail: 'ρ' }, { label: '\\varrho', detail: 'ϱ' },
  { label: '\\sigma', detail: 'σ' }, { label: '\\Sigma', detail: 'Σ' },
  { label: '\\tau', detail: 'τ' },
  { label: '\\upsilon', detail: 'υ' }, { label: '\\Upsilon', detail: 'Υ' },
  { label: '\\phi', detail: 'ϕ' }, { label: '\\varphi', detail: 'φ' },
  { label: '\\Phi', detail: 'Φ' },
  { label: '\\chi', detail: 'χ' },
  { label: '\\psi', detail: 'ψ' }, { label: '\\Psi', detail: 'Ψ' },
  { label: '\\omega', detail: 'ω' }, { label: '\\Omega', detail: 'Ω' },

  // Relations
  { label: '\\leq', detail: '≤' }, { label: '\\geq', detail: '≥' },
  { label: '\\neq', detail: '≠' }, { label: '\\approx', detail: '≈' },
  { label: '\\equiv', detail: '≡' }, { label: '\\sim', detail: '∼' },
  { label: '\\simeq', detail: '≃' }, { label: '\\cong', detail: '≅' },
  { label: '\\propto', detail: '∝' }, { label: '\\ll', detail: '≪' },
  { label: '\\gg', detail: '≫' }, { label: '\\prec', detail: '≺' },
  { label: '\\succ', detail: '≻' }, { label: '\\preceq', detail: '≼' },
  { label: '\\succeq', detail: '≽' },

  // Set theory
  { label: '\\in', detail: '∈' }, { label: '\\notin', detail: '∉' },
  { label: '\\subset', detail: '⊂' }, { label: '\\supset', detail: '⊃' },
  { label: '\\subseteq', detail: '⊆' }, { label: '\\supseteq', detail: '⊇' },
  { label: '\\cup', detail: '∪' }, { label: '\\cap', detail: '∩' },
  { label: '\\bigcup', detail: '⋃' }, { label: '\\bigcap', detail: '⋂' },
  { label: '\\setminus', detail: '∖' }, { label: '\\emptyset', detail: '∅' },
  { label: '\\varnothing', detail: '∅ (variant)' },

  // Logic
  { label: '\\forall', detail: '∀' }, { label: '\\exists', detail: '∃' },
  { label: '\\nexists', detail: '∄' },
  { label: '\\neg', detail: '¬' }, { label: '\\land', detail: '∧' },
  { label: '\\lor', detail: '∨' }, { label: '\\implies', detail: '⟹' },
  { label: '\\iff', detail: '⟺' }, { label: '\\vdash', detail: '⊢' },
  { label: '\\models', detail: '⊨' },

  // Arrows
  { label: '\\rightarrow', detail: '→' }, { label: '\\leftarrow', detail: '←' },
  { label: '\\leftrightarrow', detail: '↔' },
  { label: '\\Rightarrow', detail: '⇒' }, { label: '\\Leftarrow', detail: '⇐' },
  { label: '\\Leftrightarrow', detail: '⇔' },
  { label: '\\mapsto', detail: '↦' }, { label: '\\hookrightarrow', detail: '↪' },
  { label: '\\uparrow', detail: '↑' }, { label: '\\downarrow', detail: '↓' },

  // Misc
  { label: '\\infty', detail: '∞' }, { label: '\\partial', detail: '∂' },
  { label: '\\nabla', detail: '∇' }, { label: '\\cdot', detail: '·' },
  { label: '\\cdots', detail: '⋯' }, { label: '\\ldots', detail: '…' },
  { label: '\\vdots', detail: '⋮' }, { label: '\\ddots', detail: '⋱' },
  { label: '\\times', detail: '×' }, { label: '\\otimes', detail: '⊗' },
  { label: '\\oplus', detail: '⊕' }, { label: '\\circ', detail: '∘' },
  { label: '\\bullet', detail: '•' }, { label: '\\star', detail: '⋆' },
  { label: '\\dagger', detail: '†' },
  { label: '\\ell', detail: 'ℓ' }, { label: '\\hbar', detail: 'ℏ' },
  { label: '\\Re', detail: 'ℜ' }, { label: '\\Im', detail: 'ℑ' },
  { label: '\\aleph', detail: 'ℵ' },

  // Delimiters
  { label: '\\langle', detail: '⟨' }, { label: '\\rangle', detail: '⟩' },
  { label: '\\lfloor', detail: '⌊' }, { label: '\\rfloor', detail: '⌋' },
  { label: '\\lceil', detail: '⌈' }, { label: '\\rceil', detail: '⌉' },
  { label: '\\lVert', detail: '‖ (left)' }, { label: '\\rVert', detail: '‖ (right)' },
];

const REFERENCE_COMMANDS = [
  { label: '\\label', insertText: '\\label{${1:key}}', detail: 'Label' },
  { label: '\\ref', insertText: '\\ref{${1:key}}', detail: 'Reference' },
  { label: '\\eqref', insertText: '\\eqref{${1:key}}', detail: 'Equation reference' },
  { label: '\\cref', insertText: '\\cref{${1:key}}', detail: 'Clever ref (cleveref)' },
  { label: '\\autoref', insertText: '\\autoref{${1:key}}', detail: 'Auto reference (hyperref)' },
  { label: '\\cite', insertText: '\\cite{${1:key}}', detail: 'Citation' },
  { label: '\\citep', insertText: '\\citep{${1:key}}', detail: 'Parenthetical citation' },
  { label: '\\citet', insertText: '\\citet{${1:key}}', detail: 'Textual citation' },
  { label: '\\pageref', insertText: '\\pageref{${1:key}}', detail: 'Page reference' },
];

const DOCUMENT_COMMANDS = [
  { label: '\\usepackage', insertText: '\\usepackage{${1:package}}', detail: 'Use package' },
  { label: '\\usepackage[]', insertText: '\\usepackage[${1:options}]{${2:package}}', detail: 'Use package with options' },
  { label: '\\documentclass', insertText: '\\documentclass{${1:article}}', detail: 'Document class' },
  { label: '\\documentclass[]', insertText: '\\documentclass[${1:options}]{${2:article}}', detail: 'Document class with options' },
  { label: '\\newcommand', insertText: '\\newcommand{\\${1:name}}[${2:args}]{${3:def}}', detail: 'New command' },
  { label: '\\renewcommand', insertText: '\\renewcommand{\\${1:name}}[${2:args}]{${3:def}}', detail: 'Renew command' },
  { label: '\\newtheorem', insertText: '\\newtheorem{${1:name}}{${2:Printed Name}}', detail: 'New theorem env' },
  { label: '\\input', insertText: '\\input{${1:file}}', detail: 'Input file' },
  { label: '\\include', insertText: '\\include{${1:file}}', detail: 'Include file' },
  { label: '\\includegraphics', insertText: '\\includegraphics[${1:width=\\textwidth}]{${2:file}}', detail: 'Include graphics' },
  { label: '\\caption', insertText: '\\caption{${1:text}}', detail: 'Caption' },
  { label: '\\title', insertText: '\\title{${1:title}}', detail: 'Document title' },
  { label: '\\author', insertText: '\\author{${1:name}}', detail: 'Author' },
  { label: '\\date', insertText: '\\date{${1:\\today}}', detail: 'Date' },
  { label: '\\maketitle', detail: 'Render title' },
  { label: '\\tableofcontents', detail: 'Table of contents' },
  { label: '\\bibliography', insertText: '\\bibliography{${1:refs}}', detail: 'Bibliography file' },
  { label: '\\bibliographystyle', insertText: '\\bibliographystyle{${1:plain}}', detail: 'Bibliography style' },
];

const BEGIN_END_COMMANDS = [
  { label: '\\begin', insertText: '\\begin{${1:environment}}', detail: 'Begin environment' },
  { label: '\\end', insertText: '\\end{${1:environment}}', detail: 'End environment' },
];

// ─── Environment Definitions ──────────────────────────────────────────
// Some environments get special body content when auto-completed

const ENVIRONMENTS = [
  // Math
  { name: 'equation', body: '\t$0', detail: 'Numbered equation' },
  { name: 'equation*', body: '\t$0', detail: 'Unnumbered equation' },
  { name: 'align', body: '\t$0', detail: 'Aligned equations (numbered)' },
  { name: 'align*', body: '\t$0', detail: 'Aligned equations (unnumbered)' },
  { name: 'gather', body: '\t$0', detail: 'Gathered equations' },
  { name: 'gather*', body: '\t$0', detail: 'Gathered equations (unnumbered)' },
  { name: 'multline', body: '\t$0', detail: 'Multi-line equation' },
  { name: 'split', body: '\t$0', detail: 'Split equation' },
  { name: 'cases', body: '\t${1:expr} & \\text{if } ${2:cond} \\\\\\\\', detail: 'Cases' },
  { name: 'pmatrix', body: '\t${1:a} & ${2:b} \\\\\\\\\n\t${3:c} & ${4:d}', detail: 'Parenthesized matrix' },
  { name: 'bmatrix', body: '\t${1:a} & ${2:b} \\\\\\\\\n\t${3:c} & ${4:d}', detail: 'Bracketed matrix' },
  { name: 'vmatrix', body: '\t${1:a} & ${2:b} \\\\\\\\\n\t${3:c} & ${4:d}', detail: 'Determinant matrix' },

  // Lists — auto-insert \item
  { name: 'itemize', body: '\t\\item $0', detail: 'Bullet list' },
  { name: 'enumerate', body: '\t\\item $0', detail: 'Numbered list' },
  { name: 'description', body: '\t\\item[${1:term}] $0', detail: 'Description list' },

  // Theorem-like
  { name: 'theorem', body: '\t$0', detail: 'Theorem' },
  { name: 'lemma', body: '\t$0', detail: 'Lemma' },
  { name: 'proposition', body: '\t$0', detail: 'Proposition' },
  { name: 'corollary', body: '\t$0', detail: 'Corollary' },
  { name: 'definition', body: '\t$0', detail: 'Definition' },
  { name: 'remark', body: '\t$0', detail: 'Remark' },
  { name: 'example', body: '\t$0', detail: 'Example' },
  { name: 'proof', body: '\t$0', detail: 'Proof' },

  // Floats & structure
  { name: 'figure', body: '\t\\centering\n\t\\includegraphics[width=${1:\\textwidth}]{${2:file}}\n\t\\caption{${3:caption}}\n\t\\label{fig:${4:label}}', detail: 'Figure float' },
  { name: 'table', body: '\t\\centering\n\t\\caption{${1:caption}}\n\t\\label{tab:${2:label}}\n\t\\begin{tabular}{${3:c|c}}\n\t\t\\hline\n\t\t${4:A} & ${5:B} \\\\\\\\\n\t\t\\hline\n\t\\end{tabular}', detail: 'Table float' },
  { name: 'tabular', body: '\t\\hline\n\t${1:A} & ${2:B} \\\\\\\\\n\t\\hline', detail: 'Tabular' },
  { name: 'minipage', body: '\t$0', detail: 'Minipage' },
  { name: 'center', body: '\t$0', detail: 'Centered content' },
  { name: 'abstract', body: '\t$0', detail: 'Abstract' },
  { name: 'verbatim', body: '\t$0', detail: 'Verbatim text' },
  { name: 'lstlisting', body: '\t$0', detail: 'Code listing' },
  { name: 'tikzpicture', body: '\t$0', detail: 'TikZ picture' },
  { name: 'frame', body: '\t\\frametitle{${1:Title}}\n\t$0', detail: 'Beamer frame' },

  // Document
  { name: 'document', body: '\n$0\n', detail: 'Document body' },
];

// Environments that get \item on Enter
const LIST_ENVIRONMENTS = new Set(['itemize', 'enumerate', 'description']);

// Quick-insert full environment snippets from \ trigger (type \itemize, \equation, etc.)
const ENV_SHORTCUT_COMMANDS = ENVIRONMENTS.map(env => ({
  label: `\\${env.name}`,
  insertText: `\\begin{${env.name}}\n${env.body}\n\\end{${env.name}}`,
  detail: `${env.detail} (quick insert)`,
}));

const ALL_COMMANDS = [
  ...BEGIN_END_COMMANDS,
  ...SECTION_COMMANDS,
  ...TEXT_COMMANDS,
  ...MATH_COMMANDS,
  ...MATH_SYMBOLS,
  ...REFERENCE_COMMANDS,
  ...DOCUMENT_COMMANDS,
  ...ENV_SHORTCUT_COMMANDS,
];

// ─── Register Providers ──────────────────────────────────────────────

export function registerLaTeXCompletions(monaco, editor) {
  // 1. Command completion (triggered by \)
  const commandProvider = monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['\\'],

    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn - 1, // include the backslash
        endColumn: word.endColumn,
      };

      // Also extract labels from document for \ref{} completion
      const suggestions = ALL_COMMANDS.map((cmd, i) => ({
        label: cmd.label,
        kind: cmd.insertText
          ? monaco.languages.CompletionItemKind.Snippet
          : monaco.languages.CompletionItemKind.Function,
        insertText: cmd.insertText || cmd.label,
        insertTextRules: cmd.insertText
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          : undefined,
        detail: cmd.detail || '',
        documentation: cmd.documentation,
        range,
        sortText: String(i).padStart(4, '0'),
      }));

      return { suggestions };
    },
  });

  // 2. Environment completion (triggered after \begin{)
  const envProvider = monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['{'],

    provideCompletionItems(model, position) {
      // Check if we're inside \begin{ or \end{
      const lineContent = model.getLineContent(position.lineNumber);
      const textBefore = lineContent.substring(0, position.column - 1);
      const textAfter = lineContent.substring(position.column - 1);

      const beginMatch = textBefore.match(/\\begin\{(\w*)$/);
      const endMatch = textBefore.match(/\\end\{(\w*)$/);

      if (!beginMatch && !endMatch) return { suggestions: [] };

      const partial = (beginMatch || endMatch)?.[1] || '';

      // Check if there's an auto-paired "}" (or "partial}") right after the cursor
      // that we need to consume to avoid the double-brace bug
      const afterMatch = textAfter.match(/^(\w*)\}/);
      const trailingChars = afterMatch ? afterMatch[0].length : 0;

      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - partial.length,
        endColumn: position.column + trailingChars, // consume the auto-paired }
      };

      if (beginMatch) {
        // For \begin{, suggest environments and auto-insert \end{}
        const suggestions = ENVIRONMENTS.map((env, i) => {
          // No trailing } in snippet — the range already eats the auto-paired one
          const snippet = `${env.name}}\n${env.body}\n\\\\end{${env.name}}`;
          return {
            label: env.name,
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: snippet,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: env.detail || `\\begin{${env.name}} ... \\end{${env.name}}`,
            range,
            sortText: String(i).padStart(4, '0'),
          };
        });
        return { suggestions };
      }

      if (endMatch) {
        // For \end{, suggest environments that are currently open
        const fullText = model.getValue();
        const openEnvs = findOpenEnvironments(fullText, model.getOffsetAt(position));
        const envNames = openEnvs.length > 0
          ? openEnvs
          : ENVIRONMENTS.map(e => e.name);

        const suggestions = envNames.map((name, i) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Struct,
          insertText: name + (trailingChars > 0 ? '' : '}'),  // don't add } if range already eats it
          detail: `Close \\end{${name}}`,
          range,
          sortText: String(i).padStart(4, '0'),
        }));
        return { suggestions };
      }

      return { suggestions: [] };
    },
  });

  // 3. Label/cite completion (triggered inside \ref{, \cite{, etc.)
  const refProvider = monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['{', ','],

    provideCompletionItems(model, position) {
      const lineContent = model.getLineContent(position.lineNumber);
      const textBefore = lineContent.substring(0, position.column - 1);

      // Check if inside \ref{, \cref{, \autoref{, \eqref{, \pageref{, \cite{, etc.
      const refMatch = textBefore.match(/\\(?:ref|cref|Cref|autoref|eqref|pageref)\{([^}]*)$/);
      const citeMatch = textBefore.match(/\\(?:cite|citep|citet|citealp)\{([^}]*)$/);

      if (!refMatch && !citeMatch) return { suggestions: [] };

      const partial = (refMatch || citeMatch)?.[1]?.split(',').pop()?.trim() || '';
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - partial.length,
        endColumn: position.column,
      };

      if (refMatch) {
        // Extract all \label{...} from document
        const fullText = model.getValue();
        const labels = extractLabels(fullText);
        return {
          suggestions: labels.map((lbl, i) => ({
            label: lbl.key,
            kind: monaco.languages.CompletionItemKind.Reference,
            insertText: lbl.key,
            detail: lbl.context,
            range,
            sortText: String(i).padStart(4, '0'),
          })),
        };
      }

      return { suggestions: [] };
    },
  });

  // 4. Smart Enter key — auto-insert \item in list environments
  editor.addCommand(monaco.KeyCode.Enter, () => {
    const position = editor.getPosition();
    const model = editor.getModel();
    const lineContent = model.getLineContent(position.lineNumber);

    // Detect if we're inside a list environment
    const fullText = model.getValue();
    const offset = model.getOffsetAt(position);
    const openEnvs = findOpenEnvironments(fullText, offset);
    const inList = openEnvs.find(env => LIST_ENVIRONMENTS.has(env));

    if (inList) {
      // Check if current line has \item
      const trimmed = lineContent.trim();
      if (trimmed.startsWith('\\item') || trimmed === '') {
        // Get indentation of current line
        const indent = lineContent.match(/^(\s*)/)?.[1] || '';
        const isDescription = inList === 'description';
        const itemText = isDescription ? '\\item[] ' : '\\item ';

        // If current line is just a bare \item with no content, don't add another
        if (trimmed === '\\item' || trimmed === '\\item[]') {
          // User pressed Enter on empty item — just do normal newline
          editor.trigger('keyboard', 'type', { text: '\n' });
          return;
        }

        editor.trigger('keyboard', 'type', { text: `\n${indent}${itemText}` });
        return;
      }
    }

    // Default Enter behavior
    editor.trigger('keyboard', 'type', { text: '\n' });
  }, '!suggestWidgetVisible && !renameInputVisible');

  return [commandProvider, envProvider, refProvider];
}

// ─── Helper: find open environments at a given offset ──────────────

function findOpenEnvironments(text, offset) {
  const relevantText = text.substring(0, offset);
  const stack = [];
  const beginRegex = /\\begin\{(\w+\*?)\}/g;
  const endRegex = /\\end\{(\w+\*?)\}/g;

  // Collect all begin/end with positions
  const events = [];
  let m;
  while ((m = beginRegex.exec(relevantText)) !== null) {
    events.push({ type: 'begin', name: m[1], pos: m.index });
  }
  while ((m = endRegex.exec(relevantText)) !== null) {
    events.push({ type: 'end', name: m[1], pos: m.index });
  }
  events.sort((a, b) => a.pos - b.pos);

  for (const ev of events) {
    if (ev.type === 'begin') {
      stack.push(ev.name);
    } else {
      // pop matching begin
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === ev.name) {
          stack.splice(i, 1);
          break;
        }
      }
    }
  }

  return stack.reverse(); // innermost first
}

// ─── Helper: extract all \label{} keys from document ──────────────

function extractLabels(text) {
  const labels = [];
  const lines = text.split('\n');
  const regex = /\\label\{([^}]+)\}/g;

  for (let i = 0; i < lines.length; i++) {
    let m;
    while ((m = regex.exec(lines[i])) !== null) {
      // Get some context (the theorem/section heading)
      let context = '';
      for (let j = i; j >= Math.max(0, i - 3); j--) {
        const secMatch = lines[j].match(/\\(?:section|subsection|chapter)\*?\{([^}]+)\}/);
        const envMatch = lines[j].match(/\\begin\{(\w+)\}(?:\[([^\]]*)\])?/);
        if (secMatch) { context = secMatch[1]; break; }
        if (envMatch) { context = `${envMatch[1]}${envMatch[2] ? ': ' + envMatch[2] : ''}`; break; }
      }
      labels.push({ key: m[1], context: context || `Line ${i + 1}` });
    }
    regex.lastIndex = 0;
  }

  return labels;
}

// ─── Auto-pairing configuration for Monaco ──────────────────────────

export const LATEX_AUTO_PAIRS = {
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
    { open: '`', close: "'" },     // LaTeX quotes: `` → ''
    { open: '\\left(', close: '\\right)' },
    { open: '\\left[', close: '\\right]' },
    { open: '\\left\\{', close: '\\right\\}' },
    { open: '\\left|', close: '\\right|' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
    { open: '$$', close: '$$' },
  ],
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
};
