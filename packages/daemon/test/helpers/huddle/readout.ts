import { huddleComponentSchema, type HuddleComponent } from '@puddle/shared';
import { schedulerSnapshot } from './scheduler.js';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';

export function readoutSnapshot(
  huddleId: string,
  source: string,
  support?: HuddleComponent['readout'],
) {
  const snapshot = schedulerSnapshot(huddleId, source);
  const component = huddleComponentSchema.parse({
    ...snapshot.components.worker,
    id: 'fixture.readout.delivery',
    category: 'readout',
    title: 'Delivery',
    readout: support ?? { idempotent: false, reconciliation: 'none', cancellation: 'signal' },
    outputs: { completed: { schema: {} } },
  });
  snapshot.components.worker = component;
  snapshot.files['nodes/example/node.json'] = JSON.stringify(component);
  snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
  return snapshot;
}
