import { z } from 'zod';
import { huddleKeySchema } from '@puddle/shared';
import { ViewStateStore } from '../../editor/tabs/view-state-store';

export const huddleCameraSchema = z.strictObject({
  x: z.number().finite().min(-4_000_000).max(4_000_000),
  y: z.number().finite().min(-4_000_000).max(4_000_000),
  zoom: z.number().finite().min(0.001).max(2),
});
export type HuddleCamera = z.infer<typeof huddleCameraSchema>;
const schema = z.strictObject({
  format: z.literal(1),
  selectedNode: huddleKeySchema.nullable(),
  selectedEdge: huddleKeySchema.nullable(),
  mode: z.enum(['graph', 'list']),
  camera: huddleCameraSchema.nullable(),
});
export type HuddleView = z.infer<typeof schema>;
export const huddleViews = new ViewStateStore<unknown>(500, 'huddle', true);
export function restoreHuddleView(value: unknown): HuddleView {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? parsed.data
    : {
        format: 1,
        selectedNode: null,
        selectedEdge: null,
        mode: 'graph',
        camera: null,
      };
}
