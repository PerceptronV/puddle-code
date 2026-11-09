import type { HuddleComponent } from '../../api/huddle/components.js';
import type { HuddleDefinition, HuddleNodeDefinition } from '../../api/huddle/definitions.js';
import type { HuddleJson } from '../../api/huddle/values.js';
import { canonicalHuddleJson } from '../../api/huddle/values.js';
import { resolveHuddleParameters } from '../validation/bindings.js';
import { coreHuddleComponents } from './core.js';

/** Explicit host-backed source, including a project-local event adapter. */
export function huddleHostTrigger(node: HuddleNodeDefinition, component?: HuddleComponent) {
  const ref = node.source.kind === 'builtin' ? node.source : component?.hostTrigger;
  const host = ref && coreHuddleComponents.get(`${ref.component}@${ref.version}`);
  return host?.category === 'trigger' ? host : undefined;
}

export function validateHuddleHostTrigger(component: HuddleComponent): string | undefined {
  if (!component.hostTrigger) return;
  const ref = component.hostTrigger;
  const host = coreHuddleComponents.get(`${ref.component}@${ref.version}`);
  if (host?.category !== 'trigger') return 'Unknown pinned host trigger';
  if (host.capabilities.some((capability) => !component.capabilities.includes(capability)))
    return 'Host trigger capabilities must be retained';
  for (const [name, expected] of Object.entries(host.parameters)) {
    const parameter = component.parameters[name];
    if (
      !parameter ||
      parameter.editor !== expected.editor ||
      parameter.required !== expected.required ||
      canonicalHuddleJson(JSON.parse(JSON.stringify(parameter.schema))) !==
        canonicalHuddleJson(JSON.parse(JSON.stringify(expected.schema)))
    )
      return `Host trigger parameter contract must be retained: ${name}`;
  }
}

/** Local-only settings belong to the adapter, not the host provider's strict settings. */
export function resolveHuddleHostParameters(
  definition: HuddleDefinition,
  node: HuddleNodeDefinition,
  component: HuddleComponent,
  variables: Record<string, HuddleJson>,
) {
  const host = huddleHostTrigger(node, component);
  if (!host) throw new Error('Node has no declared host trigger');
  const values = resolveHuddleParameters(definition, node, component, variables);
  return Object.fromEntries(
    Object.keys(host.parameters).flatMap((key) =>
      Object.hasOwn(values, key) ? [[key, values[key]!]] : [],
    ),
  );
}
