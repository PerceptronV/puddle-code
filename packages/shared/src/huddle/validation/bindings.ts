import type { HuddleComponent } from '../../api/huddle/components.js';
import type { HuddleDefinition, HuddleNodeDefinition } from '../../api/huddle/definitions.js';
import type { HuddleJson } from '../../api/huddle/values.js';
import { isHuddleJson } from '../../api/huddle/values.js';
import { validateHuddleValue } from './values.js';

/** Resolve JSON settings only; the host must separately resolve and authorise resources. */
export function resolveHuddleParameters(
  definition: HuddleDefinition,
  node: HuddleNodeDefinition,
  component: HuddleComponent,
  supplied: Record<string, HuddleJson>,
): Record<string, HuddleJson> {
  if (!isHuddleJson(supplied)) throw new Error('Expected bounded variable bindings');
  for (const name of Object.keys(supplied)) {
    if (!Object.hasOwn(definition.variables, name))
      throw new Error(`Unknown huddle variable: ${name}`);
  }
  const variables = new Map<string, HuddleJson>();
  for (const [name, variable] of Object.entries(definition.variables)) {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : variable.default;
    if (value === undefined) {
      if (variable.required) throw new Error(`Missing huddle variable: ${name}`);
      continue;
    }
    if (validateHuddleValue(variable.schema, value).length)
      throw new Error(`Invalid huddle variable: ${name}`);
    variables.set(name, value);
  }
  for (const name of Object.keys(node.parameters)) {
    if (!Object.hasOwn(component.parameters, name))
      throw new Error(`Unknown node parameter: ${name}`);
  }
  const values: Array<[string, HuddleJson]> = [];
  for (const [name, parameter] of Object.entries(component.parameters)) {
    const binding = node.parameters[name];
    let value: HuddleJson | undefined;
    if (binding?.kind === 'variable') {
      if (!Object.hasOwn(definition.variables, binding.name))
        throw new Error(`Unknown huddle variable: ${binding.name}`);
      value = variables.get(binding.name);
      // An explicit unavailable binding never falls back to another resource/default.
      if (value === undefined) throw new Error(`Missing bound variable: ${binding.name}`);
    } else value = binding ? binding.value : parameter.default;
    if (value === undefined) {
      if (parameter.required) throw new Error(`Missing node parameter: ${name}`);
      continue;
    }
    if (validateHuddleValue(parameter.schema, value).length)
      throw new Error(`Invalid node parameter: ${name}`);
    values.push([name, structuredClone(value)]);
  }
  const resolved = Object.fromEntries(values);
  if (!isHuddleJson(resolved)) throw new Error('Resolved node parameters exceed the value limit');
  return resolved;
}

/** Named JSON paths only; no expressions, shell substitution or recursive interpolation. */
export function renderHuddlePrompt(template: string, context: Record<string, HuddleJson>): string {
  if (!isHuddleJson(context) || template.length > 128 * 1024)
    throw new Error('Prompt input exceeds its limit');
  const encoder = new TextEncoder();
  let bytes = encoder.encode(template).length;
  const rendered = template.replace(/\{\{([^{}]*)\}\}/g, (match, expression: string) => {
    const parts = expression.trim().split('.');
    if (
      !parts.length ||
      parts.some(
        (part) =>
          !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(part) ||
          ['__proto__', 'prototype', 'constructor'].includes(part),
      )
    )
      throw new Error(`Invalid prompt reference: ${expression}`);
    let value: HuddleJson = context;
    for (const part of parts) {
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !Object.hasOwn(value, part)
      )
        throw new Error(`Missing prompt reference: ${expression}`);
      value = value[part]!;
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    bytes += encoder.encode(text).length - encoder.encode(match).length;
    if (bytes > 128 * 1024) throw new Error('Rendered prompt exceeds its limit');
    return text;
  });
  if (new TextEncoder().encode(rendered).length > 128 * 1024)
    throw new Error('Rendered prompt exceeds its limit');
  return rendered;
}
