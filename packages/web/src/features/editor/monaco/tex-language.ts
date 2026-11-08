import type { languages } from 'monaco-editor';

export const texConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: '%' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}', notIn: ['comment', 'string'] },
    { open: '[', close: ']', notIn: ['comment', 'string'] },
    { open: '(', close: ')', notIn: ['comment', 'string'] },
  ],
};

/** Locally bundled highlighting; TeX needs no language server or worker. */
export const texLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.tex',
  tokenizer: {
    root: [{ include: '@commands' }, [/[^\\%${}[\]&#_^]+/, '']],
    commands: [
      [/%.*$/, 'comment'],
      [/\\verb\*?([^a-zA-Z\s]).*?(?:\1|$)/, 'string'],
      [/\\begin\{verbatim\*?\}/, { token: 'keyword', next: '@verbatim' }],
      [
        /(\\begin)(\{)((?:equation|align|alignat|aligned|split|gather|gathered|multline|flalign|displaymath|math)\*?)(\})/,
        [
          'keyword',
          'delimiter.bracket',
          'type',
          { token: 'delimiter.bracket', next: '@mathEnvironment' },
        ],
      ],
      [
        /(\\(?:begin|end))(\{)([^}]+)(\})/,
        ['keyword', 'delimiter.bracket', 'type', 'delimiter.bracket'],
      ],
      [/\$\$/, { token: 'keyword', next: '@displayMath' }],
      [/\$/, { token: 'keyword', next: '@inlineMath' }],
      [/\\\[/, { token: 'keyword', next: '@bracketMath' }],
      [/\\\(/, { token: 'keyword', next: '@parenMath' }],
      [/\\[a-zA-Z@]+\*?/, 'keyword'],
      [/\\[^\s]/, 'keyword'],
      [/[{}[\]]/, 'delimiter.bracket'],
      [/[&#_^]/, 'keyword'],
    ],
    inlineMath: [[/\$/, { token: 'keyword', next: '@pop' }], { include: '@math' }],
    displayMath: [[/\$\$/, { token: 'keyword', next: '@pop' }], { include: '@math' }],
    bracketMath: [[/\\\]/, { token: 'keyword', next: '@pop' }], { include: '@math' }],
    parenMath: [[/\\\)/, { token: 'keyword', next: '@pop' }], { include: '@math' }],
    mathEnvironment: [
      [
        /(\\end)(\{)((?:equation|align|alignat|aligned|split|gather|gathered|multline|flalign|displaymath|math)\*?)(\})/,
        ['keyword', 'delimiter.bracket', 'type', { token: 'delimiter.bracket', next: '@pop' }],
      ],
      { include: '@math' },
    ],
    math: [
      { include: '@commands' },
      [/\d+(?:\.\d+)?/, 'number'],
      [/[+\-=<>|:!/]/, 'keyword'],
      [/[a-zA-Z]+/, 'string'],
    ],
    verbatim: [
      [/\\end\{verbatim\*?\}/, { token: 'keyword', next: '@pop' }],
      [/[^\\]+/, 'string'],
      [/\\/, 'string'],
    ],
  },
};
