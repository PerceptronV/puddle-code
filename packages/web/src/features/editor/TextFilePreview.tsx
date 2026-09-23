import 'katex/dist/katex.min.css';
import type { PreviewKind } from './preview-kind';
import type { TextPreviewProps } from './preview-controls';
import { MarkdownPreview } from './MarkdownPreview';
import { HtmlPreview } from './HtmlPreview';

export function TextFilePreview({ kind, ...props }: TextPreviewProps & { kind: PreviewKind }) {
  return kind === 'markdown' ? <MarkdownPreview {...props} /> : <HtmlPreview {...props} />;
}
