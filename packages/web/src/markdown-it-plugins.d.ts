declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it';

  const markdownItFootnote: (parser: MarkdownIt) => void;
  export default markdownItFootnote;
}

declare module 'markdown-it-mark' {
  import type { MarkdownIt } from 'markdown-it';

  const markdownItMark: (parser: MarkdownIt) => void;
  export default markdownItMark;
}
