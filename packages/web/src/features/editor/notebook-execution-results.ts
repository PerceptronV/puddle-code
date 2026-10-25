import type { NotebookExecution } from '@puddle/shared';
import type { Notebook, NotebookOutput } from './notebook-format';

/** Apply outputs by immutable cell id, retaining newer source edits and deliberate output clearing. */
export function mergeNotebookExecution(notebook: Notebook, execution: NotebookExecution): Notebook {
  let changed = false;
  const results = new Map(execution.cells.map((cell) => [cell.id, cell]));
  const cells = notebook.cells.map((cell) => {
    const result = results.get(cell.id!);
    if (cell.cell_type !== 'code' || !result || result.state === 'queued') return cell;
    const previous = cell.metadata.puddle_execution as
      { id?: unknown; revision?: unknown } | undefined;
    if (
      previous?.id === execution.id &&
      typeof previous.revision === 'number' &&
      previous.revision >= result.revision
    )
      return cell;
    // Cancelled cells that never started retain any previous result.
    if (result.state === 'cancelled' && result.elapsed_ms === undefined) return cell;
    changed = true;
    return {
      ...cell,
      outputs: result.outputs as NotebookOutput[],
      execution_count: result.execution_count,
      metadata: {
        ...cell.metadata,
        puddle_execution: {
          id: execution.id,
          revision: result.revision,
          source: result.source,
          state: result.state,
          elapsed_ms: result.elapsed_ms,
        },
      },
    };
  });
  return changed ? { ...notebook, cells } : notebook;
}
