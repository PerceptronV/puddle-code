import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import {
  coreHuddleComponents,
  huddleDefinitionPath,
  huddleDefinitionSchema,
  validateHuddleGraph,
  type HuddleDefinition,
  type HuddleDocument,
  type Session,
} from '@puddle/shared';
import { useEditorBuffer } from '../../editor/buffers/use-editor-buffer';
import {
  applyDraft,
  bufferKey,
  subscribe,
  retainModel,
  releaseModel,
} from '../../editor/buffers/buffer-store';
import { comparisonLocksBuffer } from '../../editor/conflicts/conflict-store';

/** Graph and JSON views edit one recoverable model with the existing save/conflict policy. */
export function useGraphBuffer(
  session: Session,
  captured: HuddleDocument | undefined,
  focused: boolean,
) {
  const path = huddleDefinitionPath(session.huddle_id!);
  const buffer = useEditorBuffer(session.id, path, null, undefined, { focused, live: true });
  const key = bufferKey(session.id, path);
  useEffect(() => {
    retainModel(key);
    return () => releaseModel(key);
  }, [key]);
  const text = useSyncExternalStore(
    useCallback((listener) => subscribe(key, listener), [key]),
    () => buffer.model?.getValue() ?? '',
  );
  const parsed = useMemo(() => {
    try {
      const definition = huddleDefinitionSchema.parse(JSON.parse(text));
      if (definition.id !== session.huddle_id)
        throw new Error('The definition id must match this huddle directory.');
      return { definition };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Invalid huddle definition' };
    }
  }, [text, session.huddle_id]);
  const graph = useMemo<HuddleDocument | undefined>(() => {
    const definition = parsed.definition;
    if (!definition) return;
    const components = Object.fromEntries(
      definition.nodes.flatMap((node) => {
        const original = captured?.definition.nodes.find((item) => item.id === node.id);
        const component =
          node.source.kind === 'builtin'
            ? coreHuddleComponents.get(`${node.source.component}@${node.source.version}`)
            : JSON.stringify(original?.source) === JSON.stringify(node.source)
              ? captured?.components[node.id]
              : undefined;
        return component ? [[node.id, component]] : [];
      }),
    );
    return {
      digest: captured?.digest ?? '0'.repeat(64),
      definition,
      components,
      ...(captured?.layout ? { layout: captured.layout } : {}),
      diagnostics: validateHuddleGraph(definition, new Map(Object.entries(components))),
    };
  }, [parsed, captured]);
  const locked = buffer.status !== 'ready' || comparisonLocksBuffer(buffer.conflict);
  const edit = (update: (definition: HuddleDefinition) => HuddleDefinition) => {
    const model = buffer.model;
    if (!model || locked) return;
    // Read at the gesture, so a source edit in another pane cannot be overwritten
    // by a graph callback which captured an older render.
    try {
      const current = huddleDefinitionSchema.parse(JSON.parse(model.getValue()));
      const next = huddleDefinitionSchema.parse(update(current));
      if (next.id !== session.huddle_id) throw new Error('Cannot change the huddle directory id');
      model.pushStackElement();
      applyDraft(model, `${JSON.stringify(next, null, 2)}\n`);
      model.pushStackElement();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cannot edit this graph');
    }
  };
  return { path, buffer, graph, error: parsed.error, locked, edit };
}
