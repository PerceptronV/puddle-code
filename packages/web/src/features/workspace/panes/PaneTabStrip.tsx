import { panePathLabel } from './pane-path';
import './pane-tab-strip.css';
import { useTrayHover } from '../../../components/ui/use-tray-hover';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Eye, FileCode, Link, LoaderCircle, Lock, Play, Zap, X } from 'lucide-react';
import type {
  CompilationFileTarget,
  CompilationMode,
  CompilationProvider,
  LayoutLeaf,
  Session,
  TabRef,
} from '@puddle/shared';
import { HoverMarquee } from '../../../components/hover-marquee';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utils';
import { useHotkeyLabel } from '../../../lib/navigation/hotkeys';
import { useSessionTitleRenderer } from '../../profile/use-session-title';
import { SessionGlyph } from '../../status/SessionGlyph';
import { editorTabLabel } from '../../editor/buffers/buffer-logic';
import { tabKind, type EditorTab, type EditorView } from '../../editor/tabs/editor-tabs';
import {
  LazyEditorDirtyDot,
  LazyEditorTabClose,
  LazyFileEditorSettingsMenu,
} from '../../editor/lazy-editor-parts';
import { mediaKind } from '../../editor/previews/media-kind';
import { previewKind } from '../../editor/previews/preview-kind';
import {
  compilationSourceKey,
  isCompilableSource,
  sourceExtension,
} from '../../editor/compilation/compilation-kind';
import { FileTypeIcon } from '../../explorer/file-icons';
import { FileTabContextMenu } from '../../explorer/FileTabContextMenu';
import { SessionContextMenu } from '../sessions/SessionActions';
import { SessionTabActions } from '../sessions/SessionTabActions';
import { TabTooltipBody } from './TabTooltip';
import { tabRefKey } from '../layout/layout-tree';
import { useDropIndicator } from '../layout/TilingDnd';
import { PaneWindowContextMenu } from '../../windows/PaneWindowContextMenu';
import { TabWindowContextMenu } from '../../windows/TabWindowContextMenu';
import { beginPaneWindowDrag, canDragPaneWindow } from '../../windows/pane-drag';
import { useParams } from 'react-router';
import { dropTabWindow } from '../../windows/tab-drag';
import {
  TAB_MIME,
  hasTabTransfer,
  decodeTabTransferDetails,
  encodeTabTransfer,
  hasNativeTabTransfer,
} from '../tabs/tab-transfer';

// The 7.2rem floor leaves a clickable title beside the three hover controls a stopped
// session can show (resume, archive and close). Controls overlay the right edge
// (see TabControls), so revealing them never moves neighbouring tabs. `relative`
// anchors them; `max-w-52` still caps a long title, which truncates as before.
// `select-none`: a chip's double-click PROMOTES the tab (below), and the
// browser's own double-click default would also select the title's word — the
// tab would be left with a highlighted filename nobody asked to select and no
// way to copy it from anyway.
const TAB_CLASS =
  'group relative flex min-w-[calc(var(--spacing)*28.8)] max-w-52 cursor-pointer select-none items-center gap-1.5 rounded-[var(--ui-radius)] px-2.5 text-xs transition-colors';

// The same constant-speed reveal as a too-long commit/file name in History,
// driven by this tab chip's own hover. Literal so Tailwind generates it.
const TAB_MARQUEE = 'group-hover:[transform:translateX(var(--tail))]';

/**
 * A tiling pane's tab strip (SPEC §8) — one unified strip over BOTH terminal and
 * editor tabs (merging the old `TabStrip` + `EditorTabStrip`). Each tab is
 * draggable (dnd-kit) so it can be reordered within the strip (each chip and the
 * strip's tail are droppables resolving to an insertion index, marked by a
 * caret) or dropped onto another pane to move into or split it; terminals carry
 * the session lifecycle menu, editors a dirty-aware close (behind the lazy
 * editor chunk).
 */
export function PaneTabStrip({
  leaf,
  filetreeRoot,
  sessions,
  onActivate,
  onClose,
  onPromote,
  onDropTab,
  onArchived,
  onSetView,
  compilableExtensions,
  compilationProviders,
  compilationRunningKeys,
  onRunCompilation,
  onSetCompilationMode,
  onOpenCompilationSettings,
  onNewFile,
  onRevealFile,
  onRenameFile,
}: {
  leaf: LayoutLeaf;
  filetreeRoot: string | null;
  sessions: Session[];
  onActivate: (ref: TabRef) => void;
  onClose: (ref: TabRef) => void;
  onPromote: (ref: TabRef) => void;
  onDropTab: (ref: TabRef, move?: { fromLeafId?: string; index?: number }) => void;
  onArchived: (session: string) => void;
  /** Set a previewable editor tab's source/preview/following view (SPEC §8). */
  onSetView: (ref: TabRef, view: EditorView) => void;
  /** Host provider capabilities and execution controls for compilable tabs. */
  compilableExtensions: ReadonlySet<string>;
  compilationProviders: readonly CompilationProvider[];
  compilationRunningKeys: ReadonlySet<string>;
  onRunCompilation: (tab: EditorTab) => void;
  onSetCompilationMode: (tab: EditorTab, mode: CompilationMode) => void;
  onOpenCompilationSettings?: (source: CompilationFileTarget) => void;
  /** Double-click on the strip's blank tail: open a fresh untitled file (SPEC §8). */
  onNewFile: () => void;
  /** Reveal a path-backed editor tab in Files, rebasing for external files. */
  onRevealFile: (tab: EditorTab) => void;
  /** Rename a path-backed editor tab on disk; true when the edit may close. */
  onRenameFile: (tab: EditorTab, newName: string) => Promise<boolean>;
}) {
  const { id: projectId } = useParams();
  const single = leaf.tabs.length === 1;
  const nativePaneDrag = canDragPaneWindow();
  const nativeDragStart = useRef(false);
  const [nativeIndex, setNativeIndex] = useState<number | null>(null);
  const nativeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(nativeTimer.current), []);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const branches = new Map(sessions.map((s) => [s.id, s.branch]));
  const directories = new Map(sessions.map((s) => [s.id, s.worktree_path]));
  const editorTabs = leaf.tabs.flatMap((t) => (t.type === 'editor' ? [t.tab] : []));
  const indicator = useDropIndicator();
  const paneDrag = useDraggable({
    id: `pane:${leaf.id}`,
    data: { paneId: leaf.id, tabCount: leaf.tabs.length },
  });
  const caretAt =
    nativeIndex ??
    (indicator?.leafId === leaf.id && indicator.index !== undefined ? indicator.index : null);
  const nativeInsertion = (target: EventTarget, clientX: number): number => {
    const chip = target instanceof Element ? target.closest<HTMLElement>('[data-pane-tab]') : null;
    const index = chip ? leaf.tabs.findIndex((ref) => tabRefKey(ref) === chip.dataset.paneTab) : -1;
    if (index < 0 || !chip) return leaf.tabs.length;
    const rect = chip.getBoundingClientRect();
    return index + (clientX >= rect.x + rect.width / 2 ? 1 : 0);
  };
  // The strip itself (its tail, past the last chip) drops as "append".
  const { setNodeRef: setStripRef } = useDroppable({
    id: `strip:${leaf.id}`,
    data: { leafId: leaf.id, count: leaf.tabs.length },
  });

  const labelFor = (tab: EditorTab): string => {
    const base = editorTabLabel(tab.path, tab.session, editorTabs, branches, tab.root, directories);
    if (tabKind(tab) === 'diff') return `${base} (diff)`;
    if (tabKind(tab) === 'commit') return `${base} @${(tab.sha ?? '').slice(0, 7)}`;
    return base;
  };

  const strip = (
    <div
      ref={(node) => {
        setStripRef(node);
        paneDrag.setNodeRef(node);
      }}
      data-pane-drag-handle={leaf.id}
      onDragOver={(event) => {
        if (!hasTabTransfer(event.dataTransfer.types)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setNativeIndex(nativeInsertion(event.target, event.clientX));
        clearTimeout(nativeTimer.current);
        nativeTimer.current = setTimeout(() => setNativeIndex(null), 750);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setNativeIndex(null);
      }}
      onDrop={(event) => {
        if (!hasTabTransfer(event.dataTransfer.types)) return;
        event.preventDefault();
        event.stopPropagation();
        setNativeIndex(null);
        clearTimeout(nativeTimer.current);
        const raw = event.dataTransfer.getData(TAB_MIME);
        const index = nativeInsertion(event.target, event.clientX);
        if (projectId && dropTabWindow(raw, projectId, { paneId: leaf.id, edge: 'center', index }))
          return;
        const local = decodeTabTransferDetails(raw);
        if (local) onDropTab(local.ref, { fromLeafId: local.paneId, index });
      }}
      draggable={nativePaneDrag || undefined}
      onPointerDownCapture={(event) => {
        nativeDragStart.current =
          event.target === event.currentTarget ||
          (single &&
            event.target instanceof Element &&
            !!event.target.closest('[data-pane-tab]') &&
            !event.target.closest('button, input, [role="menuitem"]'));
      }}
      onDragStart={(event) => {
        if (!nativePaneDrag || !nativeDragStart.current) {
          event.preventDefault();
          return;
        }
        beginPaneWindowDrag(event.dataTransfer, leaf.id);
      }}
      onPointerDown={(event) => {
        if (!nativePaneDrag && event.target === event.currentTarget)
          paneDrag.listeners?.onPointerDown?.(event);
      }}
      data-pane-single-edge={single || undefined}
      className={
        single
          ? 'pane-single-tab-edge cursor-grab'
          : 'flex h-[var(--ui-tab-strip-height)] shrink-0 cursor-grab items-stretch gap-1 overflow-x-auto bg-[var(--bg-pane)] p-1 active:cursor-grabbing'
      }
      // Blank space only: a double-click on a tab bubbles here with the tab
      // as the target, and that gesture is already "promote to permanent".
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) onNewFile();
      }}
    >
      {leaf.tabs.map((ref, index) => {
        const session = sessionsById.get(ref.type === 'terminal' ? ref.session : ref.tab.session);
        return (
          <Fragment key={tabRefKey(ref) === leaf.previewKey ? 'preview-slot' : tabRefKey(ref)}>
            {caretAt === index && <InsertionCaret />}
            <PaneTab
              tab={ref}
              single={single}
              nativePaneDrag={nativePaneDrag && single}
              filetreeRoot={filetreeRoot}
              leafId={leaf.id}
              index={index}
              active={tabRefKey(ref) === leaf.activeKey}
              preview={tabRefKey(ref) === leaf.previewKey}
              session={ref.type === 'terminal' ? session : undefined}
              // The worktree a FILE tab belongs to, for its hover tooltip. A tab
              // carrying a `root` is rooted outside the worktree (a browse-tree
              // `external` file) and an untitled draft's session is the nil uuid,
              // so neither resolves — and neither describes a worktree.
              fileSession={
                ref.type === 'editor' && ref.tab.root === undefined ? session : undefined
              }
              fileDirectory={
                ref.type === 'editor' &&
                (tabKind(ref.tab) === 'file' || tabKind(ref.tab) === 'external')
                  ? (ref.tab.root ?? session?.worktree_path)
                  : undefined
              }
              label={ref.type === 'editor' ? labelFor(ref.tab) : ''}
              onActivate={() => onActivate(ref)}
              onClose={() => onClose(ref)}
              onPromote={() => onPromote(ref)}
              onArchived={onArchived}
              onSetView={(view) => onSetView(ref, view)}
              compilable={isCompilableSource(
                ref.type === 'editor' ? ref.tab.path : '',
                compilableExtensions,
              )}
              provider={
                ref.type === 'editor'
                  ? compilationProviders.find((provider) =>
                      provider.extensions.includes(sourceExtension(ref.tab.path) ?? ''),
                    )
                  : undefined
              }
              compilationRunning={
                ref.type === 'editor' &&
                compilationRunningKeys.has(
                  compilationSourceKey(ref.tab.session, ref.tab.path, ref.tab.root),
                )
              }
              onRunCompilation={() => {
                if (ref.type !== 'editor') return;
                onActivate(ref);
                requestAnimationFrame(() => onRunCompilation(ref.tab));
              }}
              onSetCompilationMode={(mode) => {
                if (ref.type !== 'editor') return;
                onActivate(ref);
                requestAnimationFrame(() => onSetCompilationMode(ref.tab, mode));
              }}
              onOpenCompilationSettings={
                ref.type === 'editor' && onOpenCompilationSettings
                  ? () =>
                      onOpenCompilationSettings({
                        session: ref.tab.session,
                        path: ref.tab.path,
                        ...(ref.tab.root !== undefined ? { root: ref.tab.root } : {}),
                      })
                  : undefined
              }
              onRevealFile={() => ref.type === 'editor' && onRevealFile(ref.tab)}
              onRenameFile={(newName) =>
                ref.type === 'editor' ? onRenameFile(ref.tab, newName) : Promise.resolve(false)
              }
            />
          </Fragment>
        );
      })}
      {caretAt === leaf.tabs.length && <InsertionCaret />}
    </div>
  );
  return <PaneWindowContextMenu paneId={leaf.id}>{strip}</PaneWindowContextMenu>;
}

/** The live insertion marker a strip drag will drop the tab at. */
function InsertionCaret() {
  return <div className="w-0.5 shrink-0 self-stretch rounded-full bg-accent" />;
}

/** A compact floating island; revealing actions never changes the tab width. */
function TabControls({ children }: { children: ReactNode }) {
  const trayRef = useRef<HTMLSpanElement>(null);
  const hoverRef = useTrayHover(trayRef);
  return (
    <span
      ref={trayRef}
      className="pane-tab-controls sliding-hover-tray island-outline pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-full bg-elevated px-1 py-1 shadow-sm opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-has-[:focus-visible]:pointer-events-auto group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [&_button]:size-5 [&_button]:items-center [&_button]:justify-center [&_button]:rounded-full"
    >
      <span ref={hoverRef} aria-hidden className="tray-hover-surface" />
      {children}
    </span>
  );
}

/**
 * The markdown/HTML tab's view toggle (SPEC §8) — appears on hover like the
 * close button, styled identically (no borders, HUMANS.md). Four modes cycle
 * in place: Monaco source, rendered preview, linked preview, then the locked
 * preview that also receives proportional scroll progress.
 * The icon names the CURRENT mode — the two-state toggle could show its
 * destination, but with three an icon naming the next mode is a riddle — and
 * the title says where a click goes.
 */
const VIEW_CYCLE: Record<EditorView, EditorView> = {
  source: 'preview',
  preview: 'linked',
  linked: 'locked',
  locked: 'source',
};
const VIEW_ICON: Record<EditorView, typeof FileCode> = {
  source: FileCode,
  preview: Eye,
  linked: Link,
  locked: Lock,
};
const VIEW_TITLE: Record<EditorView, string> = {
  source: 'Source — switch to preview',
  preview: 'Preview — switch to linked preview',
  linked: 'Linked preview — switch to locked preview',
  locked: 'Locked preview — switch to source',
};

function ViewToggle({
  view,
  notebook = false,
  onSetView,
}: {
  view: EditorView;
  notebook?: boolean;
  onSetView: (view: EditorView) => void;
}) {
  const Icon = VIEW_ICON[view];
  const label = notebook
    ? view === 'source'
      ? 'Show notebook'
      : 'Show JSON source'
    : VIEW_TITLE[view];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSetView(notebook ? (view === 'source' ? 'preview' : 'source') : VIEW_CYCLE[view]);
          }}
          className="inline-flex rounded-sm p-0.5 text-fg-muted transition-colors hover:text-fg"
          aria-label={label}
        >
          <Icon className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" collisionPadding={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Explicit one-shot and daemon-observed eager modes for any compilation provider. */
function CompilationControls({
  mode,
  running,
  onRun,
  onSetMode,
  provider,
}: {
  provider: CompilationProvider | undefined;
  mode: CompilationMode;
  running: boolean;
  onRun: () => void;
  onSetMode: (mode: CompilationMode) => void;
}) {
  const eager = mode === 'eager';
  const compileKey = useHotkeyLabel('editor.compile');
  return (
    <>
      <button
        type="button"
        disabled={running}
        onClick={(event) => {
          event.stopPropagation();
          onRun();
        }}
        className={cn(
          'inline-flex rounded-sm p-0.5 transition-colors hover:text-fg disabled:cursor-wait',
          eager ? 'text-fg-muted' : 'text-accent',
        )}
        aria-label={
          provider?.terminal
            ? 'Run in terminal'
            : provider?.action === 'run'
              ? 'Run file'
              : 'Compile on demand'
        }
        title={`${
          provider?.terminal
            ? 'Run in terminal'
            : provider?.action === 'run'
              ? 'Run file'
              : 'Compile on demand'
        } (${compileKey})`}
      >
        {running && !eager ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <Play className="size-3" />
        )}
      </button>
      {provider?.eager && (
        <button
          type="button"
          disabled={running}
          onClick={(event) => {
            event.stopPropagation();
            onSetMode(eager ? 'on_demand' : 'eager');
          }}
          className={cn(
            'inline-flex rounded-sm p-0.5 transition-colors hover:text-fg disabled:cursor-wait',
            eager ? 'text-accent' : 'text-fg-muted',
          )}
          aria-label={eager ? 'Disable eager compilation' : 'Enable eager compilation'}
          title={
            eager ? 'Eager compilation — switch to on demand' : 'Compile eagerly on disk changes'
          }
        >
          {running && eager ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <Zap className="size-3" />
          )}
        </button>
      )}
    </>
  );
}

function PaneTab({
  tab,
  single,
  nativePaneDrag,
  filetreeRoot,
  leafId,
  index,
  active,
  preview,
  session,
  fileSession,
  fileDirectory,
  label,
  onActivate,
  onClose,
  onPromote,
  onArchived,
  onSetView,
  compilable,
  provider,
  compilationRunning,
  onRunCompilation,
  onSetCompilationMode,
  onOpenCompilationSettings,
  onRevealFile,
  onRenameFile,
}: {
  tab: TabRef;
  single: boolean;
  nativePaneDrag: boolean;
  filetreeRoot: string | null;
  leafId: string;
  index: number;
  active: boolean;
  preview: boolean;
  session: Session | undefined;
  /** An editor tab's own worktree session, when it has one (see the tooltip). */
  fileSession: Session | undefined;
  /** Absolute root the path-backed editor tab's `path` is relative to. */
  fileDirectory: string | undefined;
  label: string;
  onActivate: () => void;
  onClose: () => void;
  onPromote: () => void;
  onArchived: (session: string) => void;
  onSetView: (view: EditorView) => void;
  compilable: boolean;
  provider: CompilationProvider | undefined;
  compilationRunning: boolean;
  onRunCompilation: () => void;
  onSetCompilationMode: (mode: CompilationMode) => void;
  onOpenCompilationSettings?: () => void;
  onRevealFile: () => void;
  onRenameFile: (newName: string) => Promise<boolean>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const nativeTabDrag = !nativePaneDrag && hasNativeTabTransfer();
  const nativeTabStart = useRef(false);
  const { id: currentProjectId } = useParams();
  const renderTitle = useSessionTitleRenderer();
  const key = tabRefKey(tab);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    // Keyed by leaf too: legacy trees may hold the same tab in two panes, and
    // duplicate draggable ids confuse dnd-kit.
    id: `drag:${leafId}:${key}`,
    data: { ref: tab, fromLeafId: leafId },
  });
  // The chip is also a drop target, resolving to insert-before/after itself.
  const { setNodeRef: setDropRef } = useDroppable({
    id: `tabdrop:${leafId}:${key}`,
    data: { leafId, index },
  });
  const setRefs = (el: HTMLElement | null) => {
    setNodeRef(el);
    setDropRef(el);
  };
  const cls = cn(
    single
      ? 'pane-single-tab group relative flex h-2 w-full cursor-grab items-center text-xs'
      : TAB_CLASS,
    !single && (active ? 'bg-ground text-fg' : 'text-fg-secondary hover:bg-elevated'),
    // A preview (ephemeral) tab reads as italic, like VSCode — it will be
    // replaced by the next single-click open until a double-click pins it.
    preview && 'italic',
    isDragging && 'opacity-40',
  );

  const body = (
    <div
      ref={setRefs}
      {...(renaming ? {} : attributes)}
      {...(renaming || nativePaneDrag || nativeTabDrag ? {} : listeners)}
      onKeyDown={renaming ? undefined : (event) => listeners?.onKeyDown?.(event)}
      draggable={(nativeTabDrag && !renaming) || undefined}
      onPointerDownCapture={(event) => {
        nativeTabStart.current =
          event.target instanceof Element &&
          !event.target.closest('button, input, [contenteditable], [role="menuitem"]');
      }}
      onDragStart={(event) => {
        if (!nativeTabDrag) return;
        event.stopPropagation();
        if (!nativeTabStart.current) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(
          TAB_MIME,
          encodeTabTransfer(tab, {
            paneId: leafId,
            projectId: session?.project_id ?? fileSession?.project_id ?? currentProjectId,
          }),
        );
      }}
      onClick={onActivate}
      onDoubleClick={onPromote}
      className={cn(cls, renaming && 'pane-tab-renaming cursor-text select-text')}
      data-pane-tab={key}
      aria-label={
        single
          ? tab.type === 'editor'
            ? panePathLabel(tab.tab, fileDirectory, filetreeRoot)
            : session
              ? renderTitle(session)
              : tab.session
          : undefined
      }
    >
      {tab.type === 'terminal' ? (
        <>
          {/* One glyph for both facts: which agent, in the status colour. */}
          {session && (
            <SessionGlyph
              status={session.status}
              kind={session.kind}
              agentType={session.agent_type}
              detectedAgentType={session.detected_agent_type}
              stale={session.stale_running}
            />
          )}
          <span className="truncate">
            {session ? renderTitle(session) : tab.session.slice(0, 8)}
          </span>
          <TabControls>
            {session && <SessionTabActions session={session} onArchived={onArchived} />}
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="inline-flex rounded-sm p-0.5 text-fg-muted transition-colors hover:text-fg"
              aria-label="Close tab"
            >
              <X className="size-3" />
            </button>
          </TabControls>
        </>
      ) : (
        <>
          <FileTypeIcon
            name={
              tabKind(tab.tab) === 'untitled'
                ? label
                : (tab.tab.path.split('/').pop() ?? tab.tab.path)
            }
            className="size-4"
          />
          {renaming ? (
            <TabRenameInput
              initial={tab.tab.path.split('/').pop() ?? tab.tab.path}
              onCommit={onRenameFile}
              onCancel={() => setRenaming(false)}
              onCommitted={() => setRenaming(false)}
            />
          ) : (
            <>
              <HoverMarquee
                text={label}
                hoverClass={TAB_MARQUEE}
                // Sidebar rows fill their line (`flex-1`); a tab must neither grow
                // nor refuse to shrink, so its resting width follows the filename
                // until the chip reaches its cap.
                containerClassName="flex-[0_1_auto]"
                // Keep the revealed tail to the left of the controls laid over
                // this edge. The matching negative margin removes the padding
                // from the label's intrinsic width while leaving it inside the
                // measured scroll width for the marquee.
                className={
                  (tabKind(tab.tab) === 'file' || tabKind(tab.tab) === 'external') &&
                  (previewKind(tab.tab.path) !== null || compilable)
                    ? '-mr-20 pr-20'
                    : '-mr-11 pr-11'
                }
              />
              {/* In flow AFTER the filename — the chip widens for it (to its cap;
                  past that the name truncates), and it never occludes the name.
                  Hidden on hover, where the overlay × appears. */}
              <LazyEditorDirtyDot
                session={tab.tab.session}
                path={tab.tab.path}
                kind={tabKind(tab.tab)}
                root={tab.tab.root}
              />
              <TabControls>
                {/* `external` tabs render the same views (SPEC §8) — only diffs,
                    commits, and untitled drafts have no rendered counterpart. */}
                {(tabKind(tab.tab) === 'file' || tabKind(tab.tab) === 'external') &&
                  previewKind(tab.tab.path) !== null && (
                    <ViewToggle
                      notebook={previewKind(tab.tab.path) === 'notebook'}
                      view={tab.tab.view ?? 'source'}
                      onSetView={onSetView}
                    />
                  )}
                {(tabKind(tab.tab) === 'file' || tabKind(tab.tab) === 'external') &&
                  compilable &&
                  !tab.tab.generated_by && (
                    <CompilationControls
                      provider={provider}
                      mode={tab.tab.compile_mode ?? 'on_demand'}
                      running={compilationRunning}
                      onRun={onRunCompilation}
                      onSetMode={onSetCompilationMode}
                    />
                  )}
                {!mediaKind(tab.tab.path) && (
                  <LazyFileEditorSettingsMenu tab={tab.tab} onOpenChange={setSettingsOpen} />
                )}
                <LazyEditorTabClose
                  session={tab.tab.session}
                  path={tab.tab.path}
                  kind={tabKind(tab.tab)}
                  root={tab.tab.root}
                  label={label}
                  onClose={onClose}
                />
              </TabControls>
            </>
          )}
        </>
      )}
    </div>
  );

  // The hover tooltip opens BELOW the chip, into the pane's own body: a strip
  // sits at the top of its pane, so upwards it would cover the strip above it —
  // or, in the first pane, the window's traffic lights.
  const tooltip = (
    <TooltipContent
      side="bottom"
      portalled={!single}
      className={cn('max-w-[calc(100vw-2rem)] break-all', single && 'pointer-events-none z-0')}
    >
      <TabTooltipBody
        name={
          tab.type === 'terminal'
            ? session
              ? renderTitle(session)
              : tab.session
            : single
              ? panePathLabel(tab.tab, fileDirectory, filetreeRoot)
              : label
        }
        session={tab.type === 'terminal' ? session : fileSession}
      />
    </TooltipContent>
  );

  // Both triggers stack on the chip itself (as the collapsed rail's dots do):
  // `asChild` needs a DOM element, so the tooltip trigger goes INSIDE the
  // context-menu trigger rather than wrapping it.
  if (tab.type === 'terminal' && session) {
    return (
      <Tooltip>
        <SessionContextMenu
          session={session}
          paneId={leafId}
          onArchived={() => onArchived(tab.session)}
        >
          <TooltipTrigger asChild>{body}</TooltipTrigger>
        </SessionContextMenu>
        {tooltip}
      </Tooltip>
    );
  }
  if (
    tab.type === 'editor' &&
    fileDirectory !== undefined &&
    (tabKind(tab.tab) === 'file' || tabKind(tab.tab) === 'external')
  ) {
    return (
      <Tooltip open={renaming || settingsOpen ? false : undefined}>
        <FileTabContextMenu
          tab={tab.tab}
          paneId={leafId}
          projectId={fileSession?.project_id}
          directory={fileDirectory}
          onReveal={onRevealFile}
          onCompilationSettings={compilable ? onOpenCompilationSettings : undefined}
          onRename={() => setRenaming(true)}
          editing={renaming}
        >
          <TooltipTrigger asChild>{body}</TooltipTrigger>
        </FileTabContextMenu>
        {tooltip}
      </Tooltip>
    );
  }
  return (
    <Tooltip open={settingsOpen ? false : undefined}>
      <TabWindowContextMenu tab={tab} paneId={leafId}>
        <TooltipTrigger asChild>{body}</TooltipTrigger>
      </TabWindowContextMenu>
      {tooltip}
    </Tooltip>
  );
}

/** The tab-chip rename field: basename selected, Enter/blur commits, Escape cancels. */
function TabRenameInput({
  initial,
  onCommit,
  onCommitted,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => Promise<boolean>;
  onCommitted: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const claim = () => {
      el.focus();
      const dot = initial.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    };
    claim();
    const raf = requestAnimationFrame(() => {
      if (document.activeElement !== el) claim();
    });
    return () => cancelAnimationFrame(raf);
  }, [initial]);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    void onCommit(ref.current?.value ?? '').then((ok) => {
      if (ok) {
        onCommitted();
        return;
      }
      done.current = false;
      requestAnimationFrame(() => ref.current?.focus());
    });
  };

  return (
    <input
      ref={ref}
      defaultValue={initial}
      spellCheck={false}
      aria-label={`Rename ${initial}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') commit();
        else if (event.key === 'Escape') {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={commit}
      className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none"
      style={{ width: `${Math.max(8, Math.min(initial.length, 24))}ch` }}
    />
  );
}
