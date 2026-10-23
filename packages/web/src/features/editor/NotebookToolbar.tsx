import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Cpu,
  ListTree,
  MoreHorizontal,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type {
  CompilationFileTarget,
  NotebookKernelAction,
  NotebookKernelSpec,
} from '@puddle/shared';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import {
  changeNotebookKernel,
  useNotebookKernels,
  useNotebookKernelStatus,
} from '../../lib/notebook-queries';
import { notebookKernelsSupported } from '../../lib/protocol-support';
import { useDaemonVersion } from '../../lib/queries';
import {
  clearNotebookOutputs,
  notebookOutline,
  type Notebook,
  type NotebookCell,
} from './notebook-format';

const control =
  'flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-1.5 text-xs text-fg-secondary transition-colors hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-40';

export function NotebookToolbar({
  notebook,
  source,
  onChange,
  onAdd,
  onRevealCell,
  onRun,
  running = false,
}: {
  notebook: Notebook;
  source: CompilationFileTarget;
  onChange?: (notebook: Notebook) => void;
  onAdd: (type: NotebookCell['cell_type']) => void;
  onRevealCell: (index: number) => void;
  onRun?: () => void;
  running?: boolean;
}) {
  const [outlineOpen, setOutlineOpen] = useState(false);
  const version = useDaemonVersion();
  const status = useNotebookKernelStatus(
    source,
    !!onRun && notebookKernelsSupported(version.data?.protocol),
  );
  const busy = running || status.data?.state === 'busy' || status.data?.state === 'starting';
  const outline = notebookOutline(notebook);
  const hasOutputs = notebook.cells.some(
    (cell) =>
      cell.cell_type === 'code' &&
      ((cell.outputs?.length ?? 0) > 0 || cell.execution_count != null),
  );
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1 bg-ground px-3 py-2"
      role="toolbar"
      aria-label="Notebook"
    >
      {onChange && (
        <>
          <button
            type="button"
            className={control}
            disabled={notebook.cells.length >= 2000}
            onClick={() => onAdd('code')}
            aria-label="Add code cell"
          >
            <Plus className="size-3.5" />
            Code
          </button>
          <button
            type="button"
            className={control}
            disabled={notebook.cells.length >= 2000}
            onClick={() => onAdd('markdown')}
            aria-label="Add Markdown cell"
          >
            <Plus className="size-3.5" />
            Markdown
          </button>
        </>
      )}
      {onRun && (
        <button type="button" className={control} disabled={busy} onClick={onRun}>
          <Play className="size-3.5" />
          {busy ? 'Running…' : 'Run All'}
        </button>
      )}
      {onChange && (
        <button
          type="button"
          className={control}
          disabled={!hasOutputs}
          onClick={() => onChange(clearNotebookOutputs(notebook))}
        >
          <Trash2 className="size-3.5" />
          Clear All Outputs
        </button>
      )}
      <Popover open={outlineOpen} onOpenChange={setOutlineOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={control} disabled={outline.length === 0}>
            <ListTree className="size-3.5" />
            Outline
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-72 w-72 overflow-y-auto p-1">
          <nav aria-label="Notebook outline" className="flex flex-col">
            {outline.map((item) => (
              <button
                type="button"
                key={item.index}
                className={`${control} text-left`}
                onClick={() => {
                  onRevealCell(item.index);
                  setOutlineOpen(false);
                }}
              >
                <span className="w-5 shrink-0 text-fg-muted">{item.index + 1}</span>
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </nav>
        </PopoverContent>
      </Popover>
      {onChange && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={control} aria-label="More notebook actions">
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              disabled={notebook.cells.length >= 2000}
              onSelect={() => onAdd('raw')}
            >
              <Plus />
              Add raw cell
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onChange && onRun && (
        <NotebookKernelControls
          source={source}
          notebook={notebook}
          onSelect={(kernel) =>
            onChange({ ...notebook, metadata: { ...notebook.metadata, kernelspec: kernel } })
          }
        />
      )}
    </div>
  );
}

function NotebookKernelControls({
  source,
  notebook,
  onSelect,
}: {
  source: CompilationFileTarget;
  notebook: Notebook;
  onSelect: (kernel: NotebookKernelSpec) => void;
}) {
  const selection = useRef(onSelect);
  selection.current = onSelect;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const version = useDaemonVersion();
  const supported = notebookKernelsSupported(version.data?.protocol);
  const catalogue = useNotebookKernels(supported);
  const status = useNotebookKernelStatus(source, supported);
  const query = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported) return null;
  const metadata = notebook.metadata.kernelspec as { name?: unknown } | undefined;
  const name = status.data?.kernel ?? (typeof metadata?.name === 'string' ? metadata.name : '');
  const kernels = catalogue.data?.kernels ?? [];
  const current = kernels.find((kernel) => kernel.name === name);
  const live = status.data && status.data.state !== 'stopped' && status.data.state !== 'dead';
  const busy = status.data?.state === 'busy' || status.data?.state === 'starting';
  const act = async (action: NotebookKernelAction) => {
    setPending(true);
    setError(null);
    try {
      const updated = await changeNotebookKernel(action);
      query.setQueryData(['notebook-kernel', source], updated);
      if (action.action === 'select') {
        const kernel = kernels.find((kernel) => kernel.name === action.kernel);
        if (kernel && mounted.current) selection.current(kernel);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Kernel operation failed');
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <div className="ml-auto flex items-center gap-1">
        {busy && (
          <button
            type="button"
            className={control}
            disabled={pending}
            onClick={() => void act({ source, action: 'interrupt' })}
          >
            <Square className="size-3.5" />
            Interrupt
          </button>
        )}
        <span className="text-xs text-fg-muted" role="status">
          {pending
            ? 'Updating…'
            : status.data?.state === 'dead'
              ? 'Kernel exited'
              : busy
                ? 'Busy'
                : live
                  ? 'Idle'
                  : ''}
        </span>
        <Select
          value={current?.name ?? ''}
          disabled={pending || !catalogue.data?.available || kernels.length === 0}
          onValueChange={(kernel) => void act({ source, action: 'select', kernel })}
        >
          <SelectTrigger
            className="h-7 max-w-52 gap-1.5 bg-transparent text-xs hover:bg-surface"
            aria-label="Select kernel"
            title="Kernels stay alive until shut down. Changing kernels starts fresh."
          >
            <Cpu className="size-3.5 shrink-0" />
            <SelectValue placeholder={name ? `${name} (not installed)` : 'Select Kernel'} />
          </SelectTrigger>
          <SelectContent>
            {kernels.map((kernel) => (
              <SelectItem key={kernel.name} value={kernel.name} detail={kernel.language}>
                <span>{kernel.display_name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={control}
              disabled={pending}
              aria-label="Kernel actions"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!current}
              onSelect={() => void act({ source, action: 'restart' })}
            >
              <RotateCcw />
              Restart kernel
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!live}
              onSelect={() => void act({ source, action: 'shutdown' })}
            >
              <X />
              Shut down kernel
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {(error ||
        status.data?.error ||
        catalogue.data?.error ||
        catalogue.isError ||
        status.isError) && (
        <p role="alert" className="w-full px-2 text-xs text-danger">
          {error ?? status.data?.error ?? catalogue.data?.error ?? 'Couldn’t load notebook kernels'}
        </p>
      )}
      {catalogue.data && !catalogue.data.available && !catalogue.data.error && (
        <p className="w-full px-2 text-xs text-fg-muted">
          Install Jupyter and a language kernel on this host to run notebooks.
        </p>
      )}
    </>
  );
}
