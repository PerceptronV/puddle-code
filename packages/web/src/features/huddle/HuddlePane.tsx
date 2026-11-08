import { useState } from 'react';
import type { Session } from '@puddle/shared';
import { useCurrentProfileId } from '../profile/profile-store';
import { useEditor } from '../workspace/editor-context';
import { ControlTray } from '../../components/ui/control-tray';
import { PuddleGlyph } from '../../components/puddle-glyph';
import { useHuddleDocument, useHuddleSupported } from './documents/queries';
import { GraphOverview } from './canvas/GraphOverview';
import { useGraphBuffer } from './documents/use-graph-buffer';
import { ConflictSurface } from '../editor/conflicts/ConflictSurface';
import { AddNode, Connections } from './inspector/GraphEditing';
import { removeGraphNode } from './documents/graph-edits';
import { NodeAppearance } from './inspector/NodeAppearance';
import { NodeParameters } from './inspector/NodeParameters';
import { ExecutionControls } from './execution/ExecutionControls';
import { useLayoutBuffer } from './documents/use-layout-buffer';
import { NodePosition } from './inspector/NodePosition';
import { defaultPosition } from './canvas/geometry';

export function HuddlePane({ session, focused = true }: { session: Session; focused?: boolean }) {
  const supported = useHuddleSupported();
  if (!supported || !session.huddle_id)
    return (
      <p className="p-4 text-sm text-fg-muted">
        Use a current desktop or browser over a local or SSH connection to open this huddle.
      </p>
    );
  return <HuddleEditor session={session} focused={focused} />;
}

function HuddleEditor({ session, focused }: { session: Session; focused: boolean }) {
  const profile = useCurrentProfileId() ?? undefined;
  const document = useHuddleDocument(profile, session);
  const draft = useGraphBuffer(session, document.data, focused);
  const layout = useLayoutBuffer(session, focused, draft.graph?.definition);
  const { buffer, graph, edit } = draft;
  const [selected, setSelected] = useState<string | null>(null);
  const [list, setList] = useState(false);
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState(false);
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
  return (
    <section className="flex size-full min-h-0 flex-col text-fg" aria-label="Huddle editor">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-2">
        <PuddleGlyph className="size-4" />
        <span className="min-w-0 flex-1 truncate text-sm">
          {graph?.definition.name ?? session.title ?? 'Huddle'}
        </span>
        <ControlTray label="Huddle actions" className="max-w-full flex-wrap">
          <button
            type="button"
            className={actionClass}
            disabled={draft.locked || !graph}
            aria-pressed={adding}
            onClick={() => setAdding(!adding)}
          >
            Add node
          </button>
          <button
            type="button"
            className={actionClass}
            disabled={draft.locked || !graph}
            aria-pressed={connecting}
            onClick={() => setConnecting(!connecting)}
          >
            Connections
          </button>
          <button
            type="button"
            className={actionClass}
            disabled={draft.locked || !buffer.model?.canUndo()}
            onClick={() => void buffer.model?.undo()}
          >
            Undo
          </button>
          <button
            type="button"
            className={actionClass}
            disabled={draft.locked || !buffer.model?.canRedo()}
            onClick={() => void buffer.model?.redo()}
          >
            Redo
          </button>
          <button
            type="button"
            className={actionClass}
            disabled={draft.locked || (!buffer.dirty && !layout.buffer.dirty)}
            onClick={() => {
              void Promise.all([buffer.save(), layout.buffer.save()]).then(() =>
                document.refetch(),
              );
            }}
          >
            Save
          </button>
          <button
            type="button"
            className={actionClass}
            aria-pressed={list}
            onClick={() => setList(!list)}
          >
            {list ? 'Graph' : 'Node list'}
          </button>
          <button type="button" className={actionClass} onClick={() => openSource('huddle.json')}>
            Open definition
          </button>
          <button type="button" className={actionClass} onClick={() => openSource('layout.json')}>
            Open layout
          </button>
          <button
            type="button"
            className={actionClass}
            disabled={document.isFetching}
            onClick={() => {
              void document.refetch();
            }}
          >
            Refresh
          </button>
        </ControlTray>
      </div>
      {profile && (
        <ExecutionControls
          key={`${profile}:${session.id}`}
          profile={profile}
          session={session}
          focused={focused}
          locked={draft.locked || !!buffer.conflict}
        />
      )}
      {(buffer.dirty || layout.buffer.dirty) && (
        <p className="px-4 text-xs text-fg-muted">Unsaved changes</p>
      )}
      {buffer.restoredNotice && (
        <p className="px-4 text-xs text-fg-muted">Restored unsaved changes</p>
      )}
      {buffer.peerBadge && (
        <p className="px-4 text-xs text-fg-muted">This definition has changes in another window.</p>
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
      {layout.buffer.restoredNotice && (
        <p className="px-4 text-xs text-fg-muted">Restored unsaved layout changes</p>
      )}
      {layout.buffer.conflict?.phase === 'unresolved' && (
        <div className="flex items-center gap-2 px-4 text-xs text-fg-muted">
          The layout changed on disk. Your edits are intact.
          <button type="button" className={actionClass} onClick={layout.buffer.compare}>
            Compare layout
          </button>
        </div>
      )}
      {layout.buffer.status === 'error' || (layout.buffer.status === 'ready' && layout.error) ? (
        <p className="px-4 text-xs text-fg-muted">
          Layout:{' '}
          {layout.buffer.errorMessage ?? 'Fix layout.json in its source editor to arrange nodes.'}
        </p>
      ) : null}
      {buffer.conflict && buffer.conflict.phase !== 'unresolved' ? (
        <ConflictSurface session={session.id} path={draft.path} buffer={buffer} focused={focused} />
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
          {document.error && (
            <p className="px-4 text-xs text-fg-muted">
              Saved component inspection: {document.error.message}
            </p>
          )}
          {(adding || connecting) && (
            <div className="flex max-h-64 shrink-0 gap-4 overflow-auto">
              {adding && <AddNode edit={edit} profile={profile} session={session} />}
              {connecting && <Connections graph={graph} edit={edit} />}
            </div>
          )}
          {graph.diagnostics.length > 0 && (
            <details className="max-h-36 overflow-auto px-4 py-2 text-xs text-fg-muted">
              <summary className="cursor-pointer">
                {graph.diagnostics.length} validation notes
              </summary>
              {graph.diagnostics.map((item, index) => (
                <p key={index}>
                  {item.node ?? item.path}: {item.message}
                </p>
              ))}
            </details>
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
            <div className="flex min-h-0 flex-1">
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
                      <span>{graph.components[item.id]?.title ?? item.id}</span>
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
                  onDelete={(id) => edit((definition) => removeGraphNode(definition, id))}
                />
              )}
              {node && (
                <aside
                  className="w-64 shrink-0 overflow-auto p-4 text-sm"
                  aria-label="Node inspector"
                >
                  <h2 className="mb-2">{component?.title ?? node.id}</h2>
                  <p className="mb-4 text-xs text-fg-muted">
                    {node.id} · {component?.category ?? 'Unresolved'}
                  </p>
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
                  <p className="mt-4 text-xs text-fg-muted">Parameters</p>
                  <NodeParameters
                    key={node.id}
                    node={node}
                    component={component}
                    variables={graph.definition.variables}
                    session={session}
                    edit={edit}
                  />
                  <NodeAppearance node={node} component={component} edit={edit} />
                  {position && (
                    <NodePosition
                      key={`${node.id}:${position.x}:${position.y}`}
                      position={position}
                      locked={layout.locked || draft.locked}
                      apply={(value) => layout.move(node.id, value, layout.version)}
                    />
                  )}
                  <button
                    type="button"
                    className={`${actionClass} mt-4`}
                    onClick={() => edit((definition) => removeGraphNode(definition, node.id))}
                  >
                    Delete node
                  </button>
                </aside>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
