import type { HuddleComponent, HuddleJson } from '@puddle/shared';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';
import type { HuddleDefinitionSnapshot } from '../../../src/huddle/definitions/capture.js';

export function withTrigger(
  snapshot: HuddleDefinitionSnapshot,
  component: HuddleComponent,
  parameters: Record<string, HuddleJson>,
) {
  const node = snapshot.definition.nodes.find((node) => node.id === 'run')!;
  node.source = { kind: 'builtin', component: component.id, version: component.version };
  node.parameters = Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [key, { kind: 'literal' as const, value }]),
  );
  snapshot.components.run = component;
  snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
  snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
  return snapshot;
}
