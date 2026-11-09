import { useLayoutEffect, useRef } from 'react';
import { huddleBuiltinCopyFiles, type HuddleNodeDefinition, type Session } from '@puddle/shared';
import { useHuddleTemplates } from '../documents/templates';
import { graphActionClass, type EditGraph } from './GraphEditing';

export function BuiltinSource({
  node,
  session,
  profile,
  edit,
  locked,
}: {
  node: HuddleNodeDefinition;
  session: Session;
  profile?: string;
  edit: EditGraph;
  locked: boolean;
}) {
  const install = useHuddleTemplates(profile, session);
  const latest = useRef({ edit, locked });
  useLayoutEffect(() => {
    latest.current = { edit, locked };
  }, [edit, locked]);
  if (node.source.kind !== 'builtin') return null;
  const reference = { component: node.source.component, version: node.source.version };
  const copy = huddleBuiltinCopyFiles(reference);
  return (
    <div className="mb-4 flex flex-col gap-2">
      <details>
        <summary className={`${graphActionClass} cursor-pointer`}>View built-in source</summary>
        <pre
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words py-2 text-xs"
          aria-label="Built-in adapter source"
        >
          {copy.files['run.ts']}
        </pre>
      </details>
      <button
        type="button"
        className={graphActionClass}
        disabled={locked || install.isPending || !install.supportsTemplate('builtin')}
        onClick={() =>
          install.mutate(
            {
              template: 'builtin',
              builtin: reference,
              component: `copy-${crypto.randomUUID().replaceAll('-', '')}`,
            },
            {
              onSuccess: (installed) => {
                if (latest.current.locked) return;
                latest.current.edit((graph) => ({
                  ...graph,
                  nodes: graph.nodes.map((item) =>
                    item.id === node.id &&
                    item.source.kind === 'builtin' &&
                    item.source.component === reference.component &&
                    item.source.version === reference.version
                      ? { ...item, source: { kind: 'local', manifest: installed.manifest } }
                      : item,
                  ),
                }));
              },
            },
          )
        }
      >
        {install.isPending ? 'Creating local copy…' : 'Make local copy'}
      </button>
      <p className="text-xs text-fg-muted">
        Creates editable project files and changes this node's draft. Save and Apply to use them.
        {copy.component.hostTrigger &&
          ' The host keeps observing the source; this script adapts each accepted event.'}
      </p>
      {install.error && (
        <p role="status" className="text-xs text-fg-muted">
          {install.error.message}. Inspect the component files before trying again.
        </p>
      )}
    </div>
  );
}
