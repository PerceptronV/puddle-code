import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Play,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Combine,
} from 'lucide-react';
import { NotebookCellEditor } from './NotebookCellEditor';
import { NotebookLanguagePicker } from './NotebookLanguagePicker';
import { NotebookHtml, NotebookOutputView } from './NotebookOutput';
import {
  notebookText,
  notebookCellLanguage,
  type Notebook,
  type NotebookCell as Cell,
} from './notebook-format';

export type NotebookRunRange = 'cell' | 'above' | 'below';
export const notebookControl =
  'cursor-pointer rounded-sm p-1 text-fg-muted transition-colors hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-40';

export function NotebookCell({
  cell,
  notebook,
  index,
  active,
  editing,
  selected,
  editable,
  onSelect,
  onEdit,
  onSource,
  onLanguage,
  onExecute,
  onRun,
  onOperation,
  onSplit,
  onSave,
  execution,
}: {
  cell: Cell;
  notebook: Notebook;
  index: number;
  active: boolean;
  editing: boolean;
  selected: boolean;
  editable: boolean;
  onSelect: (extend: boolean) => void;
  onEdit: (editing: boolean) => void;
  onSource: (source: string) => void;
  onLanguage: (language: string) => void;
  onExecute: (mode: 'stay' | 'next' | 'insert') => void;
  onRun?: (range: NotebookRunRange) => void;
  onOperation: (
    operation: 'up' | 'down' | 'delete' | 'duplicate' | 'insert' | 'merge' | 'clear',
  ) => void;
  onSplit: (offset: number) => void;
  onSave: () => void;
  execution?: { state: string; elapsed_ms?: number; source: string };
}) {
  const [collapsed, setCollapsed] = useState(false);
  const code = cell.cell_type === 'code';
  const source = notebookText(cell.source);
  const busy = execution?.state === 'running' || execution?.state === 'queued';
  const language = notebookCellLanguage(cell, notebook);
  const action = (label: string, icon: React.ReactNode, handler: () => void, disabled = false) => (
    <button
      type="button"
      className={notebookControl}
      title={label}
      aria-label={label}
      onClick={handler}
      disabled={disabled}
    >
      {icon}
    </button>
  );
  return (
    <section
      data-notebook-cell={index}
      data-cell-id={cell.id}
      tabIndex={active ? 0 : -1}
      aria-label={`Cell ${index + 1}`}
      aria-current={active || undefined}
      className={`group/cell relative min-w-0 outline-none ${selected ? 'bg-surface' : ''}`}
      onFocus={() => {
        if (!active) onSelect(false);
      }}
      onClick={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          code &&
          !(event.target as HTMLElement).closest('.monaco-editor,a,button,input')
        ) {
          event.preventDefault();
          onRun?.('cell');
          return;
        }
        if (!(event.target as HTMLElement).closest('button,input,[role=option]'))
          onSelect(event.shiftKey && !(event.target as HTMLElement).closest('.monaco-editor'));
      }}
    >
      <div className="absolute -left-10 top-9 w-9 text-center font-mono text-xs text-fg-muted">
        <button
          type="button"
          className={`${notebookControl} group/run relative w-full`}
          disabled={!editable || (code && (!onRun || busy || !source.trim()))}
          title={
            code ? 'Run Cell (⌘/Ctrl+Enter)' : editing ? 'Show rendered cell' : 'Edit cell source'
          }
          aria-label={code ? 'Run Cell' : editing ? 'Show rendered cell' : 'Edit cell source'}
          onClick={() => (code ? onRun?.('cell') : onEdit(!editing))}
        >
          <span
            className={
              code && onRun && !busy
                ? 'group-hover/run:invisible group-focus-visible/run:invisible'
                : ''
            }
          >
            {code ? `[${busy ? '*' : (cell.execution_count ?? ' ')}]` : editing ? '[›]' : '[ ]'}
          </span>
          {code && onRun && !busy && (
            <Play className="absolute inset-0 m-auto hidden size-3.5 group-hover/run:block group-focus-visible/run:block" />
          )}
        </button>
      </div>
      <div className="mb-2 flex min-h-7 items-center gap-2 text-xs text-fg-muted">
        {editable ? (
          <NotebookLanguagePicker
            language={cell.cell_type === 'raw' ? 'raw' : language}
            onChange={onLanguage}
          />
        ) : (
          <span className="font-mono">{cell.cell_type === 'raw' ? 'raw' : language}</span>
        )}
        {execution && (
          <span role="status">
            {execution.state}
            {execution.elapsed_ms !== undefined
              ? ` · ${(execution.elapsed_ms / 1000).toFixed(1)}s`
              : ''}
          </span>
        )}
        {execution && execution.source !== source && (
          <span title="The source changed after this execution">Source changed</span>
        )}
        {editable && (
          <div className="ml-auto flex flex-wrap items-center opacity-0 focus-within:opacity-100 group-hover/cell:opacity-100 pointer-coarse:opacity-100">
            {code && onRun && (
              <>
                {action('Run Cell', <Play className="size-3.5" />, () => onRun('cell'), busy)}
                {action(
                  'Run Above',
                  <ArrowUpToLine className="size-3.5" />,
                  () => onRun('above'),
                  busy || index === 0,
                )}
                {action(
                  'Run Cell and Below',
                  <ArrowDownToLine className="size-3.5" />,
                  () => onRun('below'),
                  busy,
                )}
              </>
            )}
            {action(
              'Insert cell below',
              <Plus className="size-3.5" />,
              () => onOperation('insert'),
              notebook.cells.length >= 2000,
            )}
            {action(
              'Duplicate cell',
              <Copy className="size-3.5" />,
              () => onOperation('duplicate'),
              notebook.cells.length >= 2000,
            )}
            {action(
              'Merge with next cell',
              <Combine className="size-3.5" />,
              () => onOperation('merge'),
              cell.cell_type !== notebook.cells[index + 1]?.cell_type,
            )}
            {action(
              'Move cell up',
              <ArrowUp className="size-3.5" />,
              () => onOperation('up'),
              index === 0,
            )}
            {action(
              'Move cell down',
              <ArrowDown className="size-3.5" />,
              () => onOperation('down'),
              index === notebook.cells.length - 1,
            )}
            {action('Delete cell', <Trash2 className="size-3.5" />, () => onOperation('delete'))}
          </div>
        )}
      </div>
      {editable && (code || editing) ? (
        <NotebookCellEditor
          value={source}
          language={language}
          label={`Cell ${index + 1} source`}
          focus={active && editing}
          onChange={(value) => {
            if (value !== source) onSource(value);
          }}
          onExecute={onExecute}
          onEscape={() => {
            onEdit(false);
            document
              .querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cell.id!)}"]`)
              ?.focus();
          }}
          onSave={onSave}
          onSplit={onSplit}
        />
      ) : cell.cell_type === 'markdown' ? (
        <div
          onDoubleClick={() => {
            if (editable) onEdit(true);
          }}
          className={editable ? 'cursor-text' : ''}
        >
          <NotebookHtml text={source} markdown />
        </div>
      ) : (
        <pre
          className="overflow-x-auto whitespace-pre-wrap font-mono text-sm"
          onDoubleClick={() => {
            if (editable) onEdit(true);
          }}
        >
          {source}
        </pre>
      )}
      {!!cell.outputs?.length && (
        <div className="mt-2">
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            {action(
              collapsed ? 'Expand output' : 'Collapse output',
              collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />,
              () => setCollapsed(!collapsed),
            )}
            <span>Output</span>
            {editable &&
              action('Clear cell output', <Trash2 className="size-3" />, () =>
                onOperation('clear'),
              )}
          </div>
          {!collapsed && (
            <div className="max-h-96 overflow-auto">
              {cell.outputs.map((output, at) => (
                <div key={at} className="mt-2">
                  <NotebookOutputView output={output} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
