import { z } from 'zod';

const multiline = z.union([z.string(), z.array(z.string())]);
const metadata = z.record(z.string(), z.unknown());
const outputSchema = z.looseObject({
  output_type: z.string(),
  text: multiline.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  traceback: z.array(z.string()).optional(),
  ename: z.string().optional(),
  evalue: z.string().optional(),
});
const cellSchema = z.looseObject({
  id: z.string().optional(),
  cell_type: z.enum(['code', 'markdown', 'raw']),
  metadata,
  source: multiline,
  outputs: z.array(outputSchema).optional(),
  execution_count: z.number().int().nullable().optional(),
});
const notebookSchema = z.looseObject({
  nbformat: z.literal(4),
  nbformat_minor: z.number().int().nonnegative(),
  metadata,
  cells: z.array(cellSchema).max(2_000),
});

export type Notebook = z.infer<typeof notebookSchema>;
export type NotebookCell = Notebook['cells'][number];
export type NotebookOutput = z.infer<typeof outputSchema>;

export function parseNotebook(text: string): Notebook {
  if (text.length > 5 * 1024 * 1024)
    throw new Error('This notebook exceeds the 5 MiB editor limit.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('This notebook is not valid JSON. Switch to source to repair it.');
  }
  const result = notebookSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      'Expected a version 4 notebook with at most 2,000 valid cells. Switch to source to inspect it.',
    );
  return result.data;
}

export function notebookText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((part) => typeof part === 'string')
      ? value.join('')
      : '';
}

/** Preserve notebook/cell metadata and unknown extension fields when editing source. */
export function replaceCellSource(notebook: Notebook, index: number, source: string): Notebook {
  return {
    ...notebook,
    cells: notebook.cells.map((cell, at) =>
      at !== index
        ? cell
        : {
            ...cell,
            source: source.match(/[^\n]*\n|[^\n]+$/g) ?? [],
            ...(cell.cell_type === 'code' ? { outputs: [], execution_count: null } : {}),
          },
    ),
  };
}

export function newNotebookCell(type: NotebookCell['cell_type']): NotebookCell {
  return {
    id: crypto.randomUUID(),
    cell_type: type,
    metadata: {},
    source: [],
    ...(type === 'code' ? { outputs: [], execution_count: null } : {}),
  };
}

/** Terminal colour escapes in saved tracebacks must not obscure their text. */
export function notebookOutputText(output: NotebookOutput): string {
  const text =
    output.output_type === 'error'
      ? (output.traceback?.join('\n') ?? `${output.ename ?? 'Error'}: ${output.evalue ?? ''}`)
      : notebookText(output.text ?? output.data?.['text/plain']);
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Replace only changed JSON bytes so cell typing does not copy image outputs into undo. */
export function notebookTextEdit(
  before: string,
  after: string,
): { start: number; end: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return { start, end, text: after.slice(start, nextEnd) };
}
