import { NodeName } from './inspector/NodeName';
import { useState, useRef, useLayoutEffect } from 'react';
import type { Session } from '@puddle/shared';
import { useCurrentProfileId } from '../profile/profile-store';
import { useEditor } from '../workspace/editor-context';
import { ControlTray } from '../../components/ui/control-tray';
import {
  Plus,
  Cable,
  Settings2,
  Undo2,
  Redo2,
  Save,
  List,
  Workflow,
  FileJson,
  PanelsTopLeft,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { HuddleAction } from './controls/HuddleAction';
import { HuddlePanel, nestedIsland } from './controls/HuddlePanel';
import { PuddleGlyph } from '../../components/puddle-glyph';
import { useHuddleDocument, useHuddleSupported } from './documents/queries';
import { GraphOverview } from './canvas/GraphOverview';
import { useGraphBuffer } from './documents/use-graph-buffer';
import { ConflictSurface } from '../editor/conflicts/ConflictSurface';
import { Connections } from './inspector/GraphEditing';
import { AddNode } from './inspector/catalogue/AddNode';
import { removeGraphNode } from './documents/graph-edits';
import { NodeAppearance } from './inspector/NodeAppearance';
import { NodeParameters } from './inspector/NodeParameters';
import { ExecutionControls } from './execution/ExecutionControls';
import { useLayoutBuffer } from './documents/use-layout-buffer';
import { NodePosition } from './inspector/NodePosition';
import { connectGraph } from './documents/graph-connections';
import { defaultPosition } from './canvas/geometry';
import { AuthoringAction } from './authoring/AuthoringAction';
import { useViewStateKey } from '../editor/tabs/view-state-context';
import { useHuddleView } from './view/use-huddle-view';
import { ExecutionSettings } from './inspector/settings/ExecutionSettings';
import { NodeConcurrency } from './inspector/settings/NodeConcurrency';
import { TriggerAdmission } from './inspector/settings/TriggerAdmission';
import { BuiltinSource } from './inspector/BuiltinSource';
import { ValidationAction } from './validation/ValidationAction';

export function HuddlePane({ session, focused = true }: { session: Session; focused?: boolean }) {
  const supported = useHuddleSupported();
  const profile = useCurrentProfileId();
  const viewKey = useViewStateKey('huddle', [
    profile,
    // Placement identity already binds its immutable project/worktree; keep long paths out of IPC keys.
    session.id,
    session.project_id,
    session.huddle_id,
  ]);
  if (!supported || !session.huddle_id)
    return (
      <p className="p-4 text-sm text-fg-muted">
        Use a current desktop or browser over a local or SSH connection to open this huddle.
      </p>
    );
  return <HuddleEditor key={viewKey} viewKey={viewKey} session={session} focused={focused} />;
}

function HuddleEditor({
  session,
  focused,
  viewKey,
}: {
  session: Session;
  focused: boolean;
  viewKey: string;
}) {
  const profile = useCurrentProfileId() ?? undefined;
  const document = useHuddleDocument(profile, session);
  const draft = useGraphBuffer(session, document.data, focused);
  const layout = useLayoutBuffer(session, focused, draft.graph?.definition);
  const { buffer, graph, edit } = draft;
  const navigation = useHuddleView(viewKey);
  const selected = graph?.definition.nodes.some((node) => node.id === navigation.view.selectedNode)
    ? navigation.view.selectedNode
    : null;
  const setSelected = (selectedNode: string) => {
    navigation.save({ selectedNode });
    setPanel('node');
  };
  const list = navigation.view.mode === 'list';
  const [panel, setPanel] = useState<'add' | 'connections' | 'settings' | 'node' | null>(
    selected ? 'node' : null,
  );
  const togglePanel = (value: 'add' | 'connections' | 'settings') =>
    setPanel((current) => (current === value ? null : value));
  const { openFile } = useEditor();
  const prefix = `.puddle/huddle/${session.huddle_id}/`;
  const node = graph?.definition.nodes.find((node) => node.id === selected);
  const component = node && graph?.components[node.id];
  const position =
    node &&
    (layout.layout?.nodes[node.id] ?? defaultPosition(graph!.definition.nodes.indexOf(node)));
  const source = node?.source.kind === 'local' ? node.source.manifest : null;
  // Contract paths permit ./; editor model identities must use one spelling.
  const openSource = (file: string) =>
    openFile(
      session.id,
      prefix +
        file
          .split('/')
          .filter((part) => part !== '.')
          .join('/'),
    );
  const actionClass = 'rounded-md px-2 py-1 text-xs text-fg hover:bg-elevated disabled:opacity-50';
  const toolbar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = toolbar.current!;
    const measure = () =>
      element.parentElement?.style.setProperty(
        '--huddle-toolbar-bottom',
        `${element.offsetHeight + 24}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <section
      className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden text-fg"
      aria-label="Huddle editor"
    >
      <div
        ref={toolbar}
        className="pointer-events-none absolute inset-x-3 top-3 z-30 flex flex-wrap items-start justify-between gap-3"
      >
        <ControlTray
          label="Huddle actions"
          variant="island"
          className="pointer-events-auto max-w-full flex-wrap"
        >
          {profile && (
            <AuthoringAction
              key={`${profile}:${session.id}`}
              profile={profile}
              session={session}
              locked={draft.locked || !!buffer.conflict || !!layout.buffer.conflict}
            />
          )}
          <HuddleAction
            icon={Plus}
            label="Add node"

            disabled={draft.locked || !graph}
            aria-pressed={panel === 'add'}
            onClick={() => togglePanel('add')}
          />
          <HuddleAction
            icon={Cable}
            label="Connections"

            disabled={draft.locked || !graph}
            aria-pressed={panel === 'connections'}
            onClick={() => togglePanel('connections')}
          />
          <HuddleAction
            icon={Settings2}
            label="Settings"

            disabled={draft.locked || !graph}
            aria-pressed={panel === 'settings'}
            onClick={() => togglePanel('settings')}
          />
          <HuddleAction
            icon={Undo2}
            label="Undo"

            disabled={draft.locked || !buffer.model?.canUndo()}
            onClick={() => void buffer.model?.undo()}
          />
          <HuddleAction
            icon={Redo2}
            label="Redo"

            disabled={draft.locked || !buffer.model?.canRedo()}
            onClick={() => void buffer.model?.redo()}
          />
          <HuddleAction
            icon={Save}
            label="Save"

            disabled={draft.locked || (!buffer.dirty && !layout.buffer.dirty)}
            onClick={() => {
              void Promise.all([buffer.save(), layout.buffer.save()])
                .then(async () => {
                  const saved = await document.refetch();
                  if (saved.data?.diagnostics.length)
                    toast.warning('Huddle needs attention', {
                      description: saved.data.diagnostics
                        .map((item) => `${item.node ?? item.path}: ${item.message}`)
                        .join('\n'),
                    });
                })
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : 'Could not save huddle'),
                );
            }}
          />
          <HuddleAction
            icon={list ? Workflow : List}
            label={list ? 'Graph' : 'Node list'}

            aria-pressed={list}
            onClick={() => navigation.save({ mode: list ? 'graph' : 'list' })}
          />
          <HuddleAction
            icon={FileJson}
            label="Open definition"
            onClick={() => openSource('huddle.json')}
          />
          {profile && (
            <ValidationAction
              key={`validation:${profile}:${session.id}`}
              profile={profile}
              session={session}
            />
          )}
          <HuddleAction
            icon={PanelsTopLeft}
            label="Open layout"
            onClick={() => openSource('layout.json')}
          />
          <HuddleAction
            icon={RefreshCw}
            label="Refresh"

            disabled={document.isFetching}
            onClick={() => {
              void document.refetch();
            }}
          />
        </ControlTray>
        {profile && (
          <ExecutionControls
            key={`${profile}:${session.id}`}
            profile={profile}
            session={session}
            focused={focused}
            locked={draft.locked || !!buffer.conflict}
          />
        )}
      </div>
      {(buffer.peerBadge ||
        layout.buffer.peerBadge ||
        buffer.conflict?.phase === 'unresolved' ||
        layout.buffer.conflict?.phase === 'unresolved' ||
        layout.buffer.status === 'error' ||
        (layout.buffer.status === 'ready' && layout.error) ||
        document.error) && (
        <div className="island-outline absolute left-3 top-[var(--huddle-toolbar-bottom,4rem)] z-20 flex max-w-[calc(100%-1.5rem)] flex-col gap-2 rounded-[var(--ui-surface-radius)] bg-elevated py-3">
          {buffer.peerBadge && (
            <p className="px-4 text-xs text-fg-muted">
              This definition has changes in another window.
            </p>
          )}
          {buffer.conflict?.phase === 'unresolved' && (
            <div className="flex items-center gap-2 px-4 text-xs text-fg-muted">
              The definition changed on disk. Your edits are intact.
              <button type="button" className={actionClass} onClick={buffer.compare}>
                Compare
              </button>
            </div>
          )}
          {layout.buffer.peerBadge && (
            <p className="px-4 text-xs text-fg-muted">This layout has changes in another window.</p>
          )}
          {layout.buffer.conflict?.phase === 'unresolved' && (
            <div className="flex items-center gap-2 px-4 text-xs text-fg-muted">
              The layout changed on disk. Your edits are intact.
              <button type="button" className={actionClass} onClick={layout.buffer.compare}>
                Compare layout
              </button>
            </div>
          )}
          {layout.buffer.status === 'error' ||
          (layout.buffer.status === 'ready' && layout.error) ? (
            <p className="px-4 text-xs text-fg-muted">
              Layout:{' '}
              {layout.buffer.errorMessage ??
                'Fix layout.json in its source editor to arrange nodes.'}
            </p>
          ) : null}
          {document.error && (
            <p className="px-4 text-xs text-fg-muted">
              Saved component inspection: {document.error.message}
            </p>
          )}
        </div>
      )}
      <div
        className={`flex min-h-0 flex-1 flex-col ${(buffer.conflict?.phase && buffer.conflict.phase !== 'unresolved') || (layout.buffer.conflict?.phase && layout.buffer.conflict.phase !== 'unresolved') ? 'pt-[var(--huddle-toolbar-bottom,4rem)]' : ''}`}
      >
        {buffer.conflict && buffer.conflict.phase !== 'unresolved' ? (
          <ConflictSurface
            session={session.id}
            path={draft.path}
            buffer={buffer}
            focused={focused}
          />
        ) : layout.buffer.conflict && layout.buffer.conflict.phase !== 'unresolved' ? (
          <ConflictSurface
            session={session.id}
            path={layout.path}
            buffer={layout.buffer}
            focused={focused}
          />
        ) : buffer.status === 'error' ||
          buffer.status === 'binary' ||
          buffer.status === 'too-large' ? (
          <p className="p-4 text-sm text-fg-muted" role="alert">
            {buffer.errorMessage ?? 'This definition cannot be edited as text.'}
          </p>
        ) : buffer.status === 'loading' ? (
          <p className="p-4 text-sm text-fg-muted">Loading huddle…</p>
        ) : !graph ? (
          <div className="overflow-auto p-4 text-sm text-fg-muted">
            <p>Fix the definition in its source editor to continue editing the graph.</p>
            <pre className="whitespace-pre-wrap text-xs">{draft.error}</pre>
          </div>
        ) : (
          <>
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
              {panel && panel !== 'node' && (
                <HuddlePanel
                  key={panel}
                  title={
                    panel === 'add'
                      ? 'Add node'
                      : panel === 'connections'
                        ? 'Connections'
                        : 'Settings'
                  }
                  onClose={() => setPanel(null)}
                >
                  <div>
                    {panel === 'add' && <AddNode edit={edit} profile={profile} session={session} />}
                    {panel === 'connections' && <Connections graph={graph} edit={edit} />}
                    {panel === 'settings' && (
                      <ExecutionSettings
                        execution={graph.definition.execution}
                        edit={edit}
                        locked={draft.locked || !!buffer.conflict}
                      />
                    )}
                  </div>
                </HuddlePanel>
              )}
              {graph.definition.nodes.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
                  <PuddleGlyph className="size-16 text-fg-muted/40" />
                  <p className="text-sm text-fg-muted">This huddle is empty.</p>
                  <button
                    type="button"
                    className={actionClass}
                    onClick={() => openSource('huddle.json')}
                  >
                    Edit definition
                  </button>
                </div>
              ) : (
                <div className="flex min-h-0 min-w-0 flex-1">
                  {list ? (
                    <div className="min-w-0 flex-1 overflow-auto p-4">
                      {graph.definition.nodes.map((item) => (
                        <button
                          type="button"
                          className={`${actionClass} flex w-full gap-3 text-left`}
                          aria-pressed={selected === item.id}
                          key={item.id}
                          onClick={() => setSelected(item.id)}
                        >
                          <span>
                            {layout.layout?.labels?.[item.id] ??
                              graph.components[item.id]?.title ??
                              item.id}
                          </span>
                          <span className="text-fg-muted">{item.id}</span>
                        </button>
                      ))}
                      <p className="mt-4 text-xs text-fg-muted">Connections</p>
                      {graph.definition.edges.map((edge) => (
                        <p key={edge.id} className="py-1 text-xs">
                          {edge.from.node}.{edge.from.port} → {edge.to.node}.{edge.to.port}
                          {edge.feedback ? ` · up to ${edge.feedback.maxRounds} rounds` : ''}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <GraphOverview
                      canRename={layout.canRename}
                      rename={layout.rename}
                      changeIcon={(id, icon) =>
                        edit((definition) => ({
                          ...definition,
                          nodes: definition.nodes.map((item) =>
                            item.id === id
                              ? {
                                  ...item,
                                  appearance: {
                                    ...(item.appearance ??
                                      graph.components[id]?.appearance ?? { colour: null }),
                                    icon,
                                  },
                                }
                              : item,
                          ),
                        }))
                      }
                      camera={navigation.camera}
                      rememberCamera={navigation.rememberCamera}
                      selectedEdge={
                        graph.definition.edges.some(
                          (edge) => edge.id === navigation.view.selectedEdge,
                        )
                          ? navigation.view.selectedEdge
                          : null
                      }
                      setSelectedEdge={(selectedEdge) => navigation.save({ selectedEdge })}
                      document={{ ...graph, layout: layout.layout ?? graph.layout }}
                      selected={selected}
                      onSelect={setSelected}
                      move={layout.move}
                      version={layout.version}
                      locked={layout.locked || draft.locked}
                      undo={() => {
                        if (!layout.locked) void layout.buffer.model?.undo();
                      }}
                      redo={() => {
                        if (!layout.locked) void layout.buffer.model?.redo();
                      }}
                      canUndo={!!layout.buffer.model?.canUndo()}
                      canRedo={!!layout.buffer.model?.canRedo()}
                      graphVersion={buffer.model?.getAlternativeVersionId() ?? 0}
                      graphLocked={draft.locked}
                      disconnect={(id) =>
                        edit((definition) => ({
                          ...definition,
                          edges: definition.edges.filter((edge) => edge.id !== id),
                        }))
                      }
                      connect={(from, to, expected) =>
                        edit((definition) => {
                          if (buffer.model?.getAlternativeVersionId() !== expected)
                            throw new Error(
                              'The graph changed while connecting. Choose the output again.',
                            );
                          return connectGraph({ ...graph, definition }, from, to);
                        })
                      }
                      onDelete={(id) => edit((definition) => removeGraphNode(definition, id))}
                    />
                  )}
                  {node && panel === 'node' && (
                    <HuddlePanel
                      key={node.id}
                      title={layout.layout?.labels?.[node.id] ?? component?.title ?? node.id}
                      label="Node inspector"
                      onClose={() => setPanel(null)}
                    >
                      <div className="flex flex-col gap-3">
                        <div className={nestedIsland}>
                          <p className="mb-4 text-xs text-fg-muted">
                            {node.id} · {component?.category ?? 'Unresolved'}
                          </p>
                          {component?.description && (
                            <p className="mb-4 text-xs text-fg-muted">{component.description}</p>
                          )}
                          {component && node.source.kind === 'builtin' && (
                            <BuiltinSource
                              key={`builtin-source:${node.id}`}
                              node={node}
                              session={session}
                              profile={profile}
                              edit={edit}
                              locked={draft.locked || !!buffer.conflict}
                            />
                          )}
                          {component &&
                            Object.values(component.inputs).some(
                              (port) => port.scope === 'execution',
                            ) && (
                              <p className="mb-4 text-xs text-fg-muted">
                                Retained inputs:{' '}
                                {Object.entries(component.inputs)
                                  .filter(([, port]) => port.scope === 'execution')
                                  .map(([name]) => name)
                                  .join(', ')}
                                . Connect each once; its value is reused for this execution,
                                including feedback rounds.
                              </p>
                            )}
                          {source && (
                            <button
                              type="button"
                              className={actionClass}
                              onClick={() => openSource(source)}
                            >
                              Open contract
                            </button>
                          )}
                          {source && component?.entry && (
                            <button
                              type="button"
                              className={actionClass}
                              onClick={() =>
                                openSource(
                                  `${source.slice(0, source.lastIndexOf('/') + 1)}${component.entry}`,
                                )
                              }
                            >
                              Open script
                            </button>
                          )}
                        </div>
                        <NodeName
                          key={`name:${node.id}`}
                          value={layout.layout?.labels?.[node.id] ?? ''}
                          fallback={component?.title ?? node.id}
                          disabled={!layout.canRename}
                          rename={(value) => layout.rename(node.id, value)}
                        />
                        <p className="px-1 text-xs text-fg-muted">Parameters</p>
                        <NodeParameters
                          key={node.id}
                          node={node}
                          component={component}
                          definition={graph.definition}
                          components={graph.components}
                          session={session}
                          edit={edit}
                        />
                        <div className={nestedIsland}>
                          <NodeAppearance node={node} component={component} edit={edit} />
                        </div>
                        {component?.category === 'trigger' && (
                          <div className={nestedIsland}>
                            <TriggerAdmission
                              key={`${node.id}:${JSON.stringify(graph.definition.execution)}`}
                              node={node.id}
                              execution={graph.definition.execution}
                              edit={edit}
                              locked={draft.locked || !!buffer.conflict}
                            />
                          </div>
                        )}
                        <div className={nestedIsland}>
                          <NodeConcurrency
                            key={`${node.id}:${node.concurrency}`}
                            node={node}
                            edit={edit}
                            locked={draft.locked || !!buffer.conflict}
                          />
                        </div>
                        {position && (
                          <div className={nestedIsland}>
                            <NodePosition
                              key={`${node.id}:${position.x}:${position.y}`}
                              position={position}
                              locked={layout.locked || draft.locked}
                              apply={(value) => layout.move(node.id, value, layout.version)}
                            />
                          </div>
                        )}
                        <button
                          type="button"
                          className={`${actionClass} mt-4`}
                          onClick={() => edit((definition) => removeGraphNode(definition, node.id))}
                        >
                          Delete node
                        </button>
                      </div>
                    </HuddlePanel>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {(buffer.restoredNotice || layout.buffer.restoredNotice) && (
        <div
          className="pointer-events-none absolute bottom-3 right-3 z-20 max-w-[calc(100%-1.5rem)] rounded-[var(--ui-radius)] bg-base/90 px-2 py-1 text-right text-xs text-fg-muted"
          role="status"
        >
          {buffer.restoredNotice && <p>Restored unsaved changes</p>}
          {layout.buffer.restoredNotice && <p>Restored unsaved layout changes</p>}
        </div>
      )}
    </section>
  );
}
