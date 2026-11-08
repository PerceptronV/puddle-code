import { useState } from 'react';
import type { Session } from '@puddle/shared';
import { useCurrentProfileId } from '../profile/profile-store';
import { useEditor } from '../workspace/editor-context';
import { ControlTray } from '../../components/ui/control-tray';
import { PuddleGlyph } from '../../components/puddle-glyph';
import { useHuddleDocument, useHuddleSupported } from './documents/queries';
import { GraphOverview } from './canvas/GraphOverview';

export function HuddlePane({ session }: { session: Session }) {
  const profile = useCurrentProfileId() ?? undefined;
  const supported = useHuddleSupported();
  const document = useHuddleDocument(profile, session);
  const [selected, setSelected] = useState<string | null>(null);
  const [list, setList] = useState(false);
  const { openFile } = useEditor();
  const prefix = `.puddle/huddle/${session.huddle_id}/`;
  const graph = document.data;
  const node = graph?.definition.nodes.find((node) => node.id === selected);
  const component = node && graph?.components[node.id];
  const source = node?.source.kind === 'local' ? node.source.manifest : null;
  const openSource = (file: string) => openFile(session.id, prefix + file);
  const actionClass = 'rounded-md px-2 py-1 text-xs text-fg hover:bg-elevated disabled:opacity-50';
  return (
    <section className="flex size-full min-h-0 flex-col text-fg" aria-label="Huddle editor">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-2">
        <PuddleGlyph className="size-4" />
        <span className="min-w-0 flex-1 truncate text-sm">
          {graph?.definition.name ?? session.title ?? 'Huddle'}
        </span>
        <ControlTray label="Huddle actions">
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
          <button
            type="button"
            className={actionClass}
            disabled={!supported || document.isFetching}
            onClick={() => {
              void document.refetch();
            }}
          >
            Refresh
          </button>
        </ControlTray>
      </div>
      {!supported ? (
        <p className="p-4 text-sm text-fg-muted">
          Use a current desktop or browser over a local or SSH connection to open this huddle.
        </p>
      ) : document.error ? (
        <p className="p-4 text-sm text-fg-muted" role="alert">
          {document.error.message}
        </p>
      ) : !graph ? (
        <p className="p-4 text-sm text-fg-muted">Loading huddle…</p>
      ) : (
        <>
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
                <GraphOverview document={graph} selected={selected} onSelect={setSelected} />
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
                  <pre className="whitespace-pre-wrap break-words py-2 text-xs">
                    {JSON.stringify(node.parameters, null, 2)}
                  </pre>
                </aside>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
