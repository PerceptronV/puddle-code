import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ArrowDown, ArrowUp, Code, Plus, Trash2 } from 'lucide-react';
import { markdownToHtml } from './markdown';
import {
  parseNotebook,
  notebookText,
  notebookOutputText,
  newNotebookCell,
  replaceCellSource,
  type Notebook,
  type NotebookOutput,
} from './notebook-format';
import type { TextPreviewProps } from './preview-controls';
import { bindScrollRestoration } from './scroll-restoration';
import { useViewStateKey } from './view-state-context';

const control =
  'cursor-pointer rounded-sm p-1 text-fg-muted transition-colors hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-40';

/** Inert notebook rendering, optionally editing the same JSON buffer as the source view. */
export function NotebookPreview({
  text,
  session,
  path,
  root,
  onChange,
}: TextPreviewProps & { onChange?: (text: string) => void }) {
  const parsed = useMemo(() => {
    try {
      return { notebook: parseNotebook(text), error: null };
    } catch (error) {
      return { notebook: null, error: error instanceof Error ? error.message : 'Invalid notebook' };
    }
  }, [text]);
  const [editing, setEditing] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const viewKey = useViewStateKey('notebook', [session, root, path]);
  const ready = parsed.notebook !== null;
  useLayoutEffect(() => {
    if (!scroller.current || !content.current || !ready) return;
    const binding = bindScrollRestoration(scroller.current, content.current, viewKey);
    return () => binding.dispose();
  }, [viewKey, ready]);
  const update = (notebook: Notebook) => onChange?.(`${JSON.stringify(notebook, null, 1)}\n`);
  const notebook = parsed.notebook;
  if (!notebook)
    return (
      <p className="p-6 text-sm text-danger" role="alert">
        {parsed.error}
      </p>
    );
  const move = (index: number, delta: number) => {
    const cells = [...notebook.cells];
    const other = index + delta;
    [cells[index], cells[other]] = [cells[other]!, cells[index]!];
    setEditing(null);
    update({ ...notebook, cells });
  };
  return (
    <div ref={scroller} className="h-full overflow-auto bg-ground text-fg">
      <div ref={content} className="mx-auto flex max-w-4xl flex-col gap-7 p-6">
        <p className="text-xs text-fg-muted">{notebook.cells.length} cells</p>
        {notebook.cells.map((cell, index) => (
          <section key={index} className="group/cell min-w-0" aria-label={`Cell ${index + 1}`}>
            <div className="mb-2 flex min-h-7 items-center gap-2 text-xs text-fg-muted">
              <span className="font-mono">
                {cell.cell_type === 'code' ? `[${cell.execution_count ?? ' '}]` : cell.cell_type}
              </span>
              {onChange && (
                <div className="ml-auto flex items-center opacity-0 focus-within:opacity-100 group-hover/cell:opacity-100 pointer-coarse:opacity-100">
                  {cell.cell_type === 'markdown' && (
                    <button
                      className={control}
                      title="Edit Markdown cell"
                      aria-label="Edit Markdown cell"
                      onClick={() => setEditing(editing === index ? null : index)}
                    >
                      <Code className="size-3.5" />
                    </button>
                  )}
                  <button
                    className={control}
                    disabled={index === 0}
                    title="Move cell up"
                    aria-label="Move cell up"
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button
                    className={control}
                    disabled={index === notebook.cells.length - 1}
                    title="Move cell down"
                    aria-label="Move cell down"
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </button>
                  <button
                    className={control}
                    title="Delete cell"
                    aria-label="Delete cell"
                    onClick={() => {
                      setEditing(null);
                      update({
                        ...notebook,
                        cells: notebook.cells.filter((_, at) => at !== index),
                      });
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )}
            </div>
            {onChange && (cell.cell_type !== 'markdown' || editing === index) ? (
              <textarea
                aria-label={`Cell ${index + 1} source`}
                value={notebookText(cell.source)}
                rows={Math.max(2, Math.min(24, notebookText(cell.source).split('\n').length))}
                spellCheck={false}
                onChange={(event) => update(replaceCellSource(notebook, index, event.target.value))}
                className="w-full resize-y rounded-md bg-surface p-3 font-mono text-sm leading-relaxed text-fg outline-none focus:bg-elevated"
              />
            ) : cell.cell_type === 'markdown' ? (
              <NotebookHtml text={notebookText(cell.source)} markdown />
            ) : (
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-sm">
                {notebookText(cell.source)}
              </pre>
            )}
            {cell.outputs?.map((output, at) => (
              <div key={at} className="mt-3">
                <NotebookOutputView output={output} />
              </div>
            ))}
          </section>
        ))}
        {onChange && (
          <div className="flex gap-3">
            {(['code', 'markdown', 'raw'] as const).map((type) => (
              <button
                key={type}
                disabled={notebook.cells.length >= 2_000}
                className={`${control} flex items-center gap-1.5 text-xs`}
                onClick={() => {
                  setEditing(notebook.cells.length);
                  update({ ...notebook, cells: [...notebook.cells, newNotebookCell(type)] });
                }}
              >
                <Plus className="size-3.5" />
                {type === 'code' ? 'Code' : type === 'markdown' ? 'Markdown' : 'Raw'} cell
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NotebookHtml({ text, markdown = false }: { text: string; markdown?: boolean }) {
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

function NotebookOutputView({ output }: { output: NotebookOutput }) {
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
