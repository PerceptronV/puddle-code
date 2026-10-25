import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { markdownToHtml } from './markdown';
import { notebookText, notebookOutputText, type NotebookOutput } from './notebook-format';

export function NotebookHtml({ text, markdown = false }: { text: string; markdown?: boolean }) {
  const html = useMemo(
    () => ({
      __html: DOMPurify.sanitize(markdown ? markdownToHtml(text) : text, {
        FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'],
        ...(markdown ? {} : { FORBID_ATTR: ['style'] }),
      }),
    }),
    [text, markdown],
  );
  return <div className="md-preview overflow-x-auto text-sm" dangerouslySetInnerHTML={html} />;
}

export function NotebookOutputView({ output }: { output: NotebookOutput }) {
  for (const mime of ['image/png', 'image/jpeg', 'image/gif']) {
    const encoded = notebookText(output.data?.[mime]).replace(/\s/g, '');
    if (encoded && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      return (
        <img src={`data:${mime};base64,${encoded}`} alt="Notebook output" className="max-w-full" />
      );
  }
  const html = notebookText(output.data?.['text/html']);
  if (html) return <NotebookHtml text={html} />;
  const markdown = notebookText(output.data?.['text/markdown']);
  if (markdown) return <NotebookHtml text={markdown} markdown />;
  return (
    <pre
      className={`overflow-x-auto whitespace-pre-wrap font-mono text-sm ${output.output_type === 'error' ? 'text-danger' : 'text-fg-secondary'}`}
    >
      {notebookOutputText(output) || 'This output format cannot be displayed.'}
    </pre>
  );
}
