/**
 * Monaco Monarch tokenizer for LaTeX with Fermat marker support
 */
export const latexLanguage = {
  defaultToken: '',
  tokenPostfix: '.latex',

  keywords: [
    'documentclass', 'usepackage', 'begin', 'end',
    'newcommand', 'renewcommand', 'newenvironment',
    'newtheorem', 'theoremstyle',
    'title', 'author', 'date', 'maketitle',
    'section', 'subsection', 'subsubsection', 'chapter', 'part',
    'label', 'ref', 'eqref', 'cref', 'cite',
    'textbf', 'textit', 'emph', 'underline',
    'frac', 'sqrt', 'sum', 'prod', 'int', 'lim',
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'lambda', 'mu', 'sigma', 'omega',
    'infty', 'partial', 'nabla', 'forall', 'exists',
    'left', 'right', 'leq', 'geq', 'neq', 'approx', 'equiv',
    'in', 'notin', 'subset', 'supset', 'cup', 'cap',
    'mathbb', 'mathcal', 'mathfrak', 'mathrm',
    'item', 'input', 'include', 'bibliography', 'bibliographystyle',
  ],

  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.bracket' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
  ],

  tokenizer: {
    root: [
      // [PROVE IT: X] markers — special highlighting
      [/\[PROVE\s+IT:\s*Easy[^\]]*\]/, 'prove-it-easy'],
      [/\[PROVE\s+IT:\s*Medium[^\]]*\]/, 'prove-it-medium'],
      [/\[PROVE\s+IT:\s*Hard[^\]]*\]/, 'prove-it-hard'],

      // Comments
      [/%.*$/, 'comment'],

      // Math mode
      [/\$\$/, { token: 'string.math', next: '@mathDisplay' }],
      [/\$/, { token: 'string.math', next: '@mathInline' }],
      [/\\\[/, { token: 'string.math', next: '@mathDisplay' }],
      [/\\\(/, { token: 'string.math', next: '@mathInline' }],

      // Commands
      [/\\[a-zA-Z@]+/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'tag',
        },
      }],

      // Environments — begin/end
      [/\\begin\{/, { token: 'keyword', next: '@envName' }],
      [/\\end\{/, { token: 'keyword', next: '@envName' }],

      // Braces
      [/[{}]/, 'delimiter.curly'],
      [/[\[\]]/, 'delimiter.bracket'],

      // Special characters
      [/[&~^_]/, 'operator'],

      // Numbers
      [/\d+/, 'number'],
    ],

    mathInline: [
      [/[^$\\]+/, 'string.math'],
      [/\\[a-zA-Z]+/, 'string.math.command'],
      [/\$/, { token: 'string.math', next: '@pop' }],
      [/./, 'string.math'],
    ],

    mathDisplay: [
      [/[^$\\]+/, 'string.math'],
      [/\\[a-zA-Z]+/, 'string.math.command'],
      [/\$\$/, { token: 'string.math', next: '@pop' }],
      [/\\\]/, { token: 'string.math', next: '@pop' }],
      [/./, 'string.math'],
    ],

    envName: [
      [/[a-zA-Z*]+/, 'type.identifier'],
      [/\}/, { token: 'keyword', next: '@pop' }],
    ],
  },
};

/**
 * Monaco theme matching Fermat's Catppuccin-inspired dark theme
 */
export const latexTheme = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6c7086', fontStyle: 'italic' },
    { token: 'keyword', foreground: '89b4fa', fontStyle: 'bold' },
    { token: 'tag', foreground: 'cba6f7' },
    { token: 'string.math', foreground: 'a6e3a1' },
    { token: 'string.math.command', foreground: 'a6e3a1', fontStyle: 'bold' },
    { token: 'type.identifier', foreground: 'fab387', fontStyle: 'bold' },
    { token: 'delimiter.curly', foreground: 'f9e2af' },
    { token: 'delimiter.bracket', foreground: '94e2d5' },
    { token: 'operator', foreground: 'f38ba8' },
    { token: 'number', foreground: 'fab387' },

    // PROVE IT markers
    { token: 'prove-it-easy', foreground: 'a6e3a1', fontStyle: 'bold' },
    { token: 'prove-it-medium', foreground: 'f9e2af', fontStyle: 'bold' },
    { token: 'prove-it-hard', foreground: 'f38ba8', fontStyle: 'bold' },
  ],
  colors: {
    'editor.background': '#1e1e2e',
    'editor.foreground': '#cdd6f4',
    'editor.lineHighlightBackground': '#252536',
    'editor.selectionBackground': '#45475a',
    'editorCursor.foreground': '#89b4fa',
    'editorLineNumber.foreground': '#6c7086',
    'editorLineNumber.activeForeground': '#cdd6f4',
    'editor.inactiveSelectionBackground': '#313244',
    'editorGutter.background': '#181825',
  },
};
