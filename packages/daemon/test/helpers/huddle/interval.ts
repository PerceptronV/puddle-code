import { intervalHuddleTrigger } from '@puddle/shared';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';
import type { HuddleDefinitionSnapshot } from '../../../src/huddle/definitions/capture.js';

export function withInterval(snapshot: HuddleDefinitionSnapshot, intervalMs = 1000) {
  snapshot.definition.nodes.find((node) => node.id === 'run')!.source = {
    kind: 'builtin',
    component: intervalHuddleTrigger.id,
    version: 1,
  };
  snapshot.definition.nodes.find((node) => node.id === 'run')!.parameters = {
    intervalMs: { kind: 'literal', value: intervalMs },
  };
  snapshot.components.run = intervalHuddleTrigger;
  snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
  snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
  return snapshot;
}
