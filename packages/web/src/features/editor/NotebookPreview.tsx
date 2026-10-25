import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Plus } from 'lucide-react';
import { requestSave, saverKey } from './save-registry';
import { NotebookToolbar } from './NotebookToolbar';
import { NotebookCell, notebookControl } from './NotebookCell';
import {
  parseNotebook,
  notebookCellIds,
  notebookText,
  newNotebookCell,
  replaceCellSource,
  changeNotebookCellLanguage,
  type Notebook,
} from './notebook-format';
import type { TextPreviewProps } from './preview-controls';
import { bindScrollRestoration } from './scroll-restoration';
import { useViewStateKey } from './view-state-context';

/** Notebook edits share the source model's drafts, save path and conflict handling. */
export function NotebookPreview({
  text,
  session,
  path,
  root,
  onChange,
  onRun,
  running,
  onUndo,
  onRedo,
}: TextPreviewProps & {
  onChange?: (text: string) => void;
  onRun?: () => void;
  running?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const parsed = useMemo(() => {
    try {
      return { notebook: notebookCellIds(parseNotebook(text)), error: null };
    } catch (error) {
      return { notebook: null, error: error instanceof Error ? error.message : 'Invalid notebook' };
    }
  }, [text]);
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reveal = useRef<string | null>(null);
  const viewKey = useViewStateKey('notebook', [session, root, path]);
  const ready = parsed.notebook !== null;
  useLayoutEffect(() => {
    if (!scroller.current || !content.current || !ready) return;
    const binding = bindScrollRestoration(scroller.current, content.current, viewKey);
    return () => binding.dispose();
  }, [viewKey, ready]);
  useLayoutEffect(() => {
    if (!reveal.current) return;
    const cell = content.current?.querySelector<HTMLElement>(
      `[data-cell-id="${CSS.escape(reveal.current)}"]`,
    );
    if (cell) {
      cell.scrollIntoView({ block: 'nearest' });
      cell.focus({ preventScroll: true });
      reveal.current = null;
    }
  });
  const update = (notebook: Notebook) => onChange?.(`${JSON.stringify(notebook, null, 1)}\n`);
  const notebook = parsed.notebook;
  if (!notebook)
    return (
      <p className="p-6 text-sm text-danger" role="alert">
        {parsed.error}
      </p>
    );
  const choose = (id: string, edit = false) => {
    setActive(id);
    setSelected([id]);
    setEditing(edit ? id : null);
    reveal.current = id;
  };
  const add = (
    type: Notebook['cells'][number]['cell_type'],
    at = notebook.cells.findIndex((cell) => cell.id === active) + 1,
  ) => {
    if (notebook.cells.length >= 2000) return;
    const cell = newNotebookCell(type);
    const cells = [...notebook.cells];
    cells.splice(active === null ? cells.length : at, 0, cell);
    update({ ...notebook, cells });
    choose(cell.id!, true);
  };
  const replace = (index: number, cell: Notebook['cells'][number]) =>
    update({
      ...notebook,
      cells: notebook.cells.map((value, at) => (at === index ? cell : value)),
    });
  const execute = (index: number, mode: 'stay' | 'next' | 'insert') => {
    setEditing(null);
    if (mode === 'insert' || (mode === 'next' && index === notebook.cells.length - 1))
      add(notebook.cells[index]!.cell_type, index + 1);
    else if (mode === 'next') choose(notebook.cells[index + 1]!.id!);
  };
  const operation = (
    index: number,
    action: 'up' | 'down' | 'delete' | 'duplicate' | 'insert' | 'merge' | 'clear',
  ) => {
    const cells = [...notebook.cells];
    const cell = cells[index]!;
    if (action === 'insert') {
      add('code', index + 1);
      return;
    }
    if (action === 'clear') {
      replace(index, { ...cell, outputs: [], execution_count: null });
      return;
    }
    if (action === 'delete') {
      cells.splice(index, 1);
      if (cells.length) choose(cells[Math.min(index, cells.length - 1)]!.id!);
    }
    if (action === 'up' || action === 'down') {
      const other = index + (action === 'up' ? -1 : 1);
      if (other < 0 || other >= cells.length) return;
      [cells[index], cells[other]] = [cells[other]!, cell];
      choose(cell.id!);
    }
    if (action === 'duplicate') {
      if (cells.length >= 2000) return;
      const copy = { ...structuredClone(cell), id: crypto.randomUUID() };
      cells.splice(index + 1, 0, copy);
      choose(copy.id, true);
    }
    if (action === 'merge') {
      const next = cells[index + 1];
      if (!next || next.cell_type !== cell.cell_type) return;
      cells[index] = {
        ...cell,
        source: `${notebookText(cell.source)}\n${notebookText(next.source)}`,
      };
      cells.splice(index + 1, 1);
      choose(cell.id!, true);
    }
    update({ ...notebook, cells });
  };
  const keyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.monaco-editor,input,textarea,[role=dialog],[role=menu],[cmdk-root]'))
      return;
    const index = notebook.cells.findIndex((cell) => cell.id === active);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) onRedo?.();
      else onUndo?.();
      return;
    }
    if (event.key === 'Enter' && index >= 0) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        execute(index, event.shiftKey ? 'next' : event.altKey ? 'insert' : 'stay');
      else setEditing(active);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(
        0,
        Math.min(notebook.cells.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
      );
      if (notebook.cells[next]) choose(notebook.cells[next]!.id!);
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === 'a' || event.key === 'b') {
        event.preventDefault();
        add('code', Math.max(0, index + (event.key === 'b' ? 1 : 0)));
      }
      if ((event.key === 'm' || event.key === 'y') && index >= 0) {
        event.preventDefault();
        replace(
          index,
          changeNotebookCellLanguage(
            notebook.cells[index]!,
            event.key === 'm' ? 'markdown' : 'python',
          ),
        );
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        update({
          ...notebook,
          cells: notebook.cells.filter((cell) => !selected.includes(cell.id!)),
        });
      }
    }
  };
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-ground"
      onKeyDown={onChange ? keyDown : undefined}
    >
      <NotebookToolbar
        notebook={notebook}
        source={{ session, path, ...(root !== undefined ? { root } : {}) }}
        onChange={onChange ? update : undefined}
        onAdd={add}
        onRun={onRun}
        running={running}
        onRevealCell={(index) => choose(notebook.cells[index]!.id!)}
      />
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-ground text-fg">
        <div ref={content} className="mx-auto flex max-w-4xl flex-col gap-7 py-6 pr-6 pl-14">
          <p className="text-xs text-fg-muted">{notebook.cells.length} cells</p>
          {notebook.cells.map((cell, index) => (
            <NotebookCell
              key={cell.id}
              cell={cell}
              notebook={notebook}
              index={index}
              active={active === cell.id}
              editing={editing === cell.id}
              selected={selected.length > 1 && selected.includes(cell.id!)}
              editable={!!onChange}
              onSelect={(extend) => {
                if (extend && active) {
                  const from = notebook.cells.findIndex((item) => item.id === active);
                  setSelected(
                    notebook.cells
                      .slice(Math.min(from, index), Math.max(from, index) + 1)
                      .map((item) => item.id!),
                  );
                } else {
                  setActive(cell.id!);
                  setSelected([cell.id!]);
                }
              }}
              onEdit={(edit) => {
                setActive(cell.id!);
                setEditing(edit ? cell.id! : null);
              }}
              onSource={(source) => update(replaceCellSource(notebook, index, source))}
              onLanguage={(language) => replace(index, changeNotebookCellLanguage(cell, language))}
              onExecute={(mode) => execute(index, mode)}
              onOperation={(action) => operation(index, action)}
              onSave={() => {
                requestSave(saverKey(session, path, root));
              }}
              onSplit={(offset) => {
                if (notebook.cells.length >= 2000) return;
                const source = notebookText(cell.source);
                const next = { ...newNotebookCell(cell.cell_type), source: source.slice(offset) };
                const cells = [...notebook.cells];
                cells.splice(index, 1, { ...cell, source: source.slice(0, offset) }, next);
                update({ ...notebook, cells });
                choose(next.id!, true);
              }}
            />
          ))}
          {onChange && (
            <div className="flex gap-3">
              {(['code', 'markdown', 'raw'] as const).map((type) => (
                <button
                  key={type}
                  disabled={notebook.cells.length >= 2000}
                  className={`${notebookControl} flex items-center gap-1.5 text-xs`}
                  onClick={() => add(type, notebook.cells.length)}
                >
                  <Plus className="size-3.5" />
                  {type === 'code' ? 'Code' : type === 'markdown' ? 'Markdown' : 'Raw'} cell
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
