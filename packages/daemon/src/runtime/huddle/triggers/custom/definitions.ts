import { HUDDLE_CUSTOM_TRIGGER_LIMIT, type HuddleRevisionActivation } from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../../huddle/definitions/capture.js';

export function customTriggerDefinitions(
  snapshot: HuddleDefinitionSnapshot,
  activation: HuddleRevisionActivation,
) {
  if (snapshot.digest !== activation.revision) throw new Error('Custom trigger revision changed');
  const nodes = snapshot.definition.nodes.filter(
    (node) => node.source.kind === 'local' && snapshot.components[node.id]?.category === 'trigger',
  );
  if (nodes.length > HUDDLE_CUSTOM_TRIGGER_LIMIT)
    throw new Error(`A huddle supports at most ${HUDDLE_CUSTOM_TRIGGER_LIMIT} custom triggers`);
  return nodes.map((node, slot) => {
    const component = snapshot.components[node.id]!;
    if (!component.entry || !component.trigger)
      throw new Error('Custom trigger needs a captured entry and resume policy');
    return {
      slot,
      node: node.id,
      component: component.id,
      version: component.version,
      resume: component.trigger.resume,
    };
  });
}
