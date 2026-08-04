import { useEffect, useState } from 'react';
import { LayoutTemplate, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { SavedLayout } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { registerHotkey } from '../../lib/hotkeys';
import {
  useCreateLayout,
  useDeleteLayout,
  useLayouts,
  usePatchLayout,
  useProjects,
} from '../../lib/queries';
import { cn } from '../../lib/utils';
import { useCurrentProfileId } from '../profile/profile-store';
import { layoutSignature } from '../workspace/layout-signature';
import { setLayoutsOpen, toggleLayouts, useLayoutBridge, useLayoutsOpen } from './layouts-store';
import { useDashboardLayouts } from './use-dashboard-layouts';

const EMPTY_SIGNATURE = layoutSignature(null);

/**
 * The Layouts popover (SPEC §11): a top-bar popover between Settings and the
 * Scratchpad, in the Scratchpad's mould. The head is the LIVE layout — named
 * after the saved layout it derives from (or "Unnamed layout"), with an honest
 * Saved / Unsaved changes state driven by `layoutSignature` — and the list
 * below is the whole profile's saved catalogue, project-scoped rows labelled
 * with their project's name. Every project keeps its own current layout under
 * project-based layout, so any row is loadable from anywhere: a cross-project
 * load lands in its own project's slice and leaves the visible layout alone,
 * and the inline discard-confirm checks exactly the state a load replaces
 * (HUMANS.md, no modal). Saving captures the live tree under the scope the
 * client's project-based-layout setting implies right now; loading a layout
 * whose scope disagrees with that setting flips the setting through the
 * bridge, which suppresses the default union/shard transition so the loaded
 * layout survives it.
 */
export function LayoutsPopover() {
  const open = useLayoutsOpen();
  const profileId = useCurrentProfileId();
  const workspaceBridge = useLayoutBridge();
  // Without a workspace the dashboard bridge drives the persisted snapshot
  // directly — loads work everywhere; it reads only while the popover is open
  // (and only when no workspace ui-state handle exists to race with).
  const dashboard = useDashboardLayouts(profileId, open && workspaceBridge === null);
  const bridge = workspaceBridge ?? dashboard;
  // The catalogue is always the WHOLE profile's (SPEC §11 Layouts): every
  // project keeps its own current layout, so any project's layouts are
  // loadable from anywhere — a cross-project load lands in ITS project's
  // slice and leaves the visible one alone.
  const layouts = useLayouts(profileId ?? undefined, undefined).data ?? [];
  const projects = useProjects(profileId ?? undefined, open && profileId !== null).data ?? [];
  const create = useCreateLayout();
  const patch = usePatchLayout();
  const remove = useDeleteLayout();

  const [savingAs, setSavingAs] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  useEffect(() => registerHotkey('layouts.toggle', toggleLayouts), []);
  // A closed popover drops any in-progress naming state.
  useEffect(() => {
    if (!open) {
      setSavingAs(false);
      setNameDraft('');
    }
  }, [open]);

  const headless = bridge?.headless === true;
  const current =
    bridge === null || headless ? null : (layouts.find((l) => l.id === bridge.layoutRef) ?? null);
  const dirty =
    bridge !== null &&
    !headless &&
    (current === null
      ? bridge.signature !== EMPTY_SIGNATURE
      : layoutSignature(current.layout_tree) !== bridge.signature);

  // A stored slice's own unsaved state: unnamed with content, or drifted from
  // the saved layout it derives from.
  const sliceDirty = (pid: string): boolean => {
    const slice = bridge?.slices?.[pid];
    if (!slice) return false; // no stored slice — nothing to lose
    const named =
      slice.layoutRef === null ? null : (layouts.find((l) => l.id === slice.layoutRef) ?? null);
    return named
      ? layoutSignature(named.layout_tree) !== slice.signature
      : slice.signature !== EMPTY_SIGNATURE;
  };

  // Whether loading `layout` would discard unsaved layout state — checked
  // against what the load actually replaces, never the unrelated visible
  // layout. A profile-scoped load under project mode retains every slice
  // (SPEC §11 Layouts), so there is nothing to confirm; a project-scoped load
  // replaces its OWN project's slice (the head when that is the open project);
  // under profile mode it additionally shards the live profile layout away.
  const discards = (layout: SavedLayout): boolean => {
    if (bridge === null) return false;
    if (layout.scope === 'profile') return bridge.scope === 'profile' && dirty;
    if (layout.project_id === null) return false;
    if (bridge.scope === 'project') {
      return !headless && layout.project_id === bridge.projectId
        ? dirty
        : sliceDirty(layout.project_id);
    }
    return dirty || sliceDirty(layout.project_id);
  };

  // The layout a live state currently derives from: the head's ref for the
  // visible layout, a slice's ref for the other projects under project-based
  // layout. Slices preserved under profile mode are dormant, not current.
  const isCurrent = (layout: SavedLayout): boolean => {
    if (bridge === null) return false;
    if (layout.scope === 'profile') {
      return bridge.scope === 'profile' && bridge.layoutRef === layout.id;
    }
    if (bridge.scope !== 'project' || layout.project_id === null) return false;
    if (!headless && layout.project_id === bridge.projectId) {
      return bridge.layoutRef === layout.id;
    }
    return bridge.slices?.[layout.project_id]?.layoutRef === layout.id;
  };

  const projectName = (id: string | null): string =>
    (id !== null ? projects.find((p) => p.id === id)?.name : undefined) ?? 'Project';

  const saveNew = (name: string) => {
    if (!bridge || !profileId) return;
    create.mutate(
      {
        profile_id: profileId,
        scope: bridge.scope,
        project_id: bridge.scope === 'project' ? bridge.projectId : undefined,
        name,
        ...bridge.capture(),
      },
      {
        // Adopt the fresh layout as the live one's name: same tree, so apply
        // only stamps `layout_ref` (and leaves every other saved row alone).
        onSuccess: (created) => bridge.apply(created),
      },
    );
    setSavingAs(false);
    setNameDraft('');
  };

  const saveOver = () => {
    if (!bridge || !current) return;
    patch.mutate({ id: current.id, ...bridge.capture() });
  };

  const load = (layout: SavedLayout) => {
    if (!bridge) return;
    if (!bridge.apply(layout)) {
      toast.error('Workspace is still loading — try again in a moment');
      return;
    }
    setLayoutsOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setLayoutsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon">
              <LayoutTemplate />
              <span className="sr-only">Layouts</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Layouts</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-[26rem] max-w-[calc(100vw-1rem)] p-0">
        <div className="flex items-center gap-2 px-5 pb-2 pt-4">
          <span className="text-2xs font-medium uppercase tracking-wide text-fg-gold">Layouts</span>
        </div>

        {/* The live layout: name, scope, and an honest saved/unsaved state. */}
        <div className="px-5 pb-3">
          {bridge === null ? (
            <p className="text-sm text-fg-muted">Loading the profile’s layout state…</p>
          ) : headless ? (
            <p className="text-sm text-fg-muted">
              Project-based layout is on — every project keeps its own layout. Open a project to
              name or save it; loading works from here.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-fg">
                  {current?.name ?? 'Unnamed layout'}
                </span>
                <span className="text-2xs uppercase tracking-wide text-fg-muted">
                  {bridge.scope === 'profile' ? 'Profile-wide' : 'Project'}
                </span>
                <span
                  className={cn(
                    'ml-auto text-2xs',
                    current !== null && !dirty ? 'text-fg-muted' : 'text-interrupted',
                  )}
                >
                  {current === null ? 'Unsaved' : dirty ? 'Unsaved changes' : 'Saved'}
                </span>
              </div>
              {current === null || savingAs ? (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = nameDraft.trim();
                    if (name) saveNew(name);
                  }}
                >
                  <Input
                    autoFocus={savingAs}
                    value={nameDraft}
                    placeholder={current === null ? 'Name this layout…' : 'New layout name…'}
                    spellCheck={false}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Escape') setSavingAs(false);
                    }}
                    className="h-8 flex-1 text-sm"
                  />
                  <Button size="sm" type="submit" disabled={!nameDraft.trim()}>
                    Save
                  </Button>
                  {current !== null && (
                    <Button variant="ghost" size="sm" onClick={() => setSavingAs(false)}>
                      Cancel
                    </Button>
                  )}
                </form>
              ) : (
                <div className="flex items-center gap-3">
                  {dirty && (
                    <button
                      type="button"
                      onClick={saveOver}
                      className="text-2xs font-medium text-fg-gold transition-colors hover:underline"
                    >
                      Save
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSavingAs(true)}
                    className="text-2xs text-fg-muted transition-colors hover:text-fg"
                  >
                    Save as new…
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="no-scrollbar max-h-[60vh] overflow-y-auto px-2 pb-3">
          {layouts.length === 0 && (
            <p className="px-3 py-3 text-sm text-fg-muted">
              No layouts yet — name and save the current layout to keep it.
            </p>
          )}
          <ul className="flex flex-col">
            {layouts.map((layout) => (
              <li key={layout.id}>
                <LayoutRow
                  layout={layout}
                  scopeLabel={
                    layout.scope === 'profile' ? 'Profile-wide' : projectName(layout.project_id)
                  }
                  isCurrent={isCurrent(layout)}
                  loadable={bridge !== null}
                  confirmBeforeLoad={discards(layout)}
                  onLoad={() => load(layout)}
                  onRename={(name) => patch.mutate({ id: layout.id, name })}
                  onDelete={() => remove.mutate(layout.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One saved layout, text first like a Scratchpad row: the name, then a
 * persistent meta+tools line. Clicking the row loads it; rename and the
 * delete/load confirms all expand inline (HUMANS.md — no modal).
 */
function LayoutRow({
  layout,
  scopeLabel,
  isCurrent,
  loadable,
  confirmBeforeLoad,
  onLoad,
  onRename,
  onDelete,
}: {
  layout: SavedLayout;
  /** "Profile-wide", or the owning project's name for a project-scoped row. */
  scopeLabel: string;
  isCurrent: boolean;
  /** False while the layout state is still loading (nothing to load into yet). */
  loadable: boolean;
  /** Loading would discard unsaved layout changes — confirm first. */
  confirmBeforeLoad: boolean;
  onLoad: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState<'load' | 'delete' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(layout.name);

  const requestLoad = () => {
    if (!loadable || renaming) return;
    if (confirmBeforeLoad && confirming !== 'load') {
      setConfirming('load');
      return;
    }
    setConfirming(null);
    onLoad();
  };

  return (
    <div
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input')) return;
        requestLoad();
      }}
      className={cn(
        'rounded-md px-3 py-2.5 transition-colors',
        loadable && 'cursor-pointer hover:bg-surface',
      )}
    >
      {renaming ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const name = nameDraft.trim();
            if (name && name !== layout.name) onRename(name);
            setRenaming(false);
          }}
        >
          <Input
            autoFocus
            value={nameDraft}
            spellCheck={false}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="h-7 flex-1 text-sm"
          />
          <Button size="sm" type="submit" disabled={!nameDraft.trim()}>
            Rename
          </Button>
        </form>
      ) : (
        <p className="flex items-baseline gap-2 text-sm font-medium text-fg">
          {layout.name}
          {isCurrent && <span className="text-2xs font-normal text-fg-gold">Current</span>}
        </p>
      )}

      {confirming === 'delete' ? (
        <div className="mt-2 flex items-center gap-3">
          <span className="text-2xs text-fg-muted">Delete this layout? This can’t be undone.</span>
          <button
            type="button"
            onClick={() => {
              setConfirming(null);
              onDelete();
            }}
            className="text-2xs font-medium text-interrupted transition-colors hover:underline"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className="text-2xs text-fg-muted transition-colors hover:text-fg"
          >
            Cancel
          </button>
        </div>
      ) : confirming === 'load' ? (
        <div className="mt-2 flex items-center gap-3">
          <span className="text-2xs text-fg-muted">Loading discards unsaved layout changes.</span>
          <button
            type="button"
            onClick={requestLoad}
            className="text-2xs font-medium text-interrupted transition-colors hover:underline"
          >
            Load
          </button>
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className="text-2xs text-fg-muted transition-colors hover:text-fg"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-2xs uppercase tracking-wide text-fg-muted">{scopeLabel}</span>
          <div className="ml-auto flex items-center gap-1">
            <RowAction
              icon={Pencil}
              label="Rename"
              onClick={() => {
                setNameDraft(layout.name);
                setRenaming(true);
              }}
            />
            <RowAction icon={Trash2} label="Delete" onClick={() => setConfirming('delete')} />
          </div>
        </div>
      )}
    </div>
  );
}

function RowAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="rounded-md p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
        >
          <Icon className="size-3.5" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
