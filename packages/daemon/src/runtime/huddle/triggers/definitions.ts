import {
  canonicalHuddleJson,
  coreHuddleComponents,
  intervalHuddleTrigger,
  calendarHuddleTrigger,
  calendarDateHuddleTrigger,
  dateHuddleTrigger,
  filetreeHuddleTrigger,
  gitHuddleTrigger,
  sessionHuddleTrigger,
  completionHuddleTrigger,
  HUDDLE_INTERVAL_LIMIT,
  huddleIntervalSettingsSchema,
  resolveHuddleParameters,
  type HuddleRevisionActivation,
  type HuddleRuntimeCapabilities,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../huddle/definitions/capture.js';

export function intervalDefinitions(
  snapshot: HuddleDefinitionSnapshot,
  activation: HuddleRevisionActivation,
) {
  const nodes = snapshot.definition.nodes.filter(
    (node) => node.source.kind === 'builtin' && node.source.component === intervalHuddleTrigger.id,
  );
  if (nodes.length > HUDDLE_INTERVAL_LIMIT)
    throw new Error(`A huddle supports at most ${HUDDLE_INTERVAL_LIMIT} interval triggers`);
  return nodes.map((node) => ({
    node: node.id,
    ...huddleIntervalSettingsSchema.parse(
      resolveHuddleParameters(
        snapshot.definition,
        node,
        snapshot.components[node.id]!,
        activation.variables,
      ),
    ),
  }));
}

/** Before launch/Apply/arming, including independently received owner requests. */
export function requireHuddleFeatures(
  snapshot: HuddleDefinitionSnapshot,
  capabilities: HuddleRuntimeCapabilities,
) {
  for (const node of snapshot.definition.nodes) {
    const component = snapshot.components[node.id]!;
    if (
      Object.values(component.parameters).some((p) => p.editor === 'secret') &&
      capabilities.integrationSecrets !== 1
    )
      throw new Error('This runtime does not support huddle integration secrets');
    if (component.nativeCompletion && capabilities.nativeFeedback !== 1)
      throw new Error('This runtime does not support native completion feedback');
    if (component.lifecycle && capabilities.lifecycle !== 1)
      throw new Error('This runtime does not support huddle session lifecycle actions');
    if (
      Object.values(component.inputs).some((port) => port.scope === 'execution') &&
      capabilities.executionInputs !== 1
    )
      throw new Error('This runtime does not support retained execution inputs');
    if (
      Object.values(component.parameters).some((parameter) =>
        ['account', 'project', 'agent'].includes(parameter.editor),
      ) &&
      capabilities.spawns !== 1
    )
      throw new Error('This runtime does not support huddle spawn resource bindings');
    if (
      node.source.kind === 'local' &&
      component.category === 'trigger' &&
      capabilities.customTriggers !== 1
    )
      throw new Error('This runtime does not support custom huddle triggers');
    if (
      node.source.kind === 'local' &&
      component.category === 'readout' &&
      capabilities.readouts !== 1
    )
      throw new Error('This runtime does not support custom huddle readouts');
    if (
      component.id === filetreeHuddleTrigger.id &&
      node.source.kind === 'builtin' &&
      capabilities.filetree !== 1
    )
      throw new Error('This runtime does not support huddle Filetree triggers');
    if (node.source.kind !== 'builtin') continue;
    if (component.id === sessionHuddleTrigger.id && capabilities.sessionEvents !== 1)
      throw new Error('This runtime does not support huddle session triggers');
    if (component.id === completionHuddleTrigger.id && capabilities.completionEvents !== 1)
      throw new Error('This runtime does not support huddle completion subscriptions');
    if (component.id === gitHuddleTrigger.id && capabilities.git !== 1)
      throw new Error('This runtime does not support huddle Git triggers');
    const expected = coreHuddleComponents.get(`${node.source.component}@${node.source.version}`);
    if (
      !expected ||
      canonicalHuddleJson(JSON.parse(JSON.stringify(expected))) !==
        canonicalHuddleJson(JSON.parse(JSON.stringify(component)))
    )
      throw new Error('Unsupported captured built-in component');
    if (component.id === intervalHuddleTrigger.id && capabilities.timers !== 1)
      throw new Error('This runtime does not support huddle interval triggers');
    if (
      [calendarHuddleTrigger.id, dateHuddleTrigger.id].includes(component.id) &&
      ![1, 2].includes(capabilities.calendar ?? 0)
    )
      throw new Error('This runtime does not support huddle calendar/date triggers');
    if (component.id === calendarDateHuddleTrigger.id && capabilities.calendar !== 2)
      throw new Error('This runtime does not support monthly/yearly huddle triggers');
  }
}

/** Host launch/Apply also needs a read-only plan to capture baselines after queued review. */
export function requireHuddleHostFeatures(
  snapshot: HuddleDefinitionSnapshot,
  capabilities: HuddleRuntimeCapabilities,
) {
  requireHuddleFeatures(snapshot, capabilities);
  if (
    capabilities.completionPlans !== 1 &&
    snapshot.definition.nodes.some(
      (node) =>
        node.source.kind === 'builtin' && node.source.component === completionHuddleTrigger.id,
    )
  )
    throw new Error('This runtime does not support huddle completion baseline plans');
}
