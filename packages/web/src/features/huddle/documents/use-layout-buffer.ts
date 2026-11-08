import { useMemo } from 'react';
import { toast } from 'sonner';
import {
  huddleLayoutSchema,
  huddleSourcePaths,
  supportsApplicationFeature,
  type Session,
  type HuddleDefinition,
} from '@puddle/shared';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { applyDraft } from '../../editor/buffers/buffer-store';
import { useHuddleSource } from './use-source-buffer';
import { defaultPosition, type Position } from '../canvas/geometry';

export function useLayoutBuffer(session: Session, focused: boolean, definition?: HuddleDefinition) {
  const source = useHuddleSource(session.id, huddleSourcePaths(session.huddle_id!)[1], focused);
  const protocol = useDaemonVersion().data?.protocol;
  const parsed = useMemo(() => {
    try {
      return { layout: huddleLayoutSchema.parse(JSON.parse(source.text)) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Invalid layout' };
    }
  }, [source.text]);
  const locked =
    source.locked ||
    !parsed.layout ||
    !supportsApplicationFeature(protocol, { major: 28, minor: 4 });
  const version = source.buffer.model?.getAlternativeVersionId() ?? 0;
  const move = (id: string, position: Position, expected: number) => {
    const model = source.buffer.model;
    if (locked || !model || !definition?.nodes.some((node) => node.id === id)) return false;
    if (model.getAlternativeVersionId() !== expected) {
      toast.error(
        'The layout changed while moving this node. Move it again from its current position.',
      );
      return false;
    }
    try {
      const layout = huddleLayoutSchema.parse(JSON.parse(model.getValue()));
      const next = huddleLayoutSchema.parse({
        ...layout,
        nodes: Object.fromEntries(
          definition.nodes.map((node, index) => [
            node.id,
            node.id === id ? position : (layout.nodes[node.id] ?? defaultPosition(index)),
          ]),
        ),
      });
      model.pushStackElement();
      applyDraft(model, JSON.stringify(next, null, 2) + '\n');
      model.pushStackElement();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cannot move this node');
      return false;
    }
  };
  return { ...source, ...parsed, locked, version, move };
}
