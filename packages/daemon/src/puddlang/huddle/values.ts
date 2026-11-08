import {
  isHuddleJson,
  validateHuddleValue,
  type HuddleComponent,
  type HuddleJson,
  type HuddlePort,
} from '@puddle/shared';
import type { HuddleValues } from './context.js';

export function immutable(value: HuddleJson): HuddleJson {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export function snapshot(values: HuddleValues): HuddleValues {
  if (
    values === null ||
    typeof values !== 'object' ||
    !isHuddleJson(values) ||
    Array.isArray(values)
  )
    throw new Error('Expected bounded named port values');
  return immutable(structuredClone(values)) as HuddleValues;
}

export function validatePorts(
  contracts: Record<string, HuddlePort>,
  values: HuddleValues,
  direction: string,
  activation: 'all' | 'any' = 'all',
) {
  if (activation === 'any' && !Object.keys(values).length)
    throw new Error('Missing input for alternative activation');
  for (const [port, contract] of Object.entries(contracts)) {
    if (!Object.hasOwn(values, port)) {
      if (contract.required && activation === 'all')
        throw new Error(`Missing ${direction} port: ${port}`);
      continue;
    }
    if (validateHuddleValue(contract.schema, values[port]).length)
      throw new Error(`Invalid ${direction} value: ${port}`);
  }
  for (const port of Object.keys(values)) {
    if (!Object.hasOwn(contracts, port)) throw new Error(`Unknown ${direction} port: ${port}`);
  }
}

export function validateParameters(component: HuddleComponent, parameters: HuddleValues) {
  for (const [name, parameter] of Object.entries(component.parameters)) {
    if (!Object.hasOwn(parameters, name)) {
      if (parameter.required) throw new Error(`Missing node parameter: ${name}`);
    } else if (validateHuddleValue(parameter.schema, parameters[name]).length)
      throw new Error(`Invalid node parameter: ${name}`);
  }
  for (const name of Object.keys(parameters)) {
    if (!Object.hasOwn(component.parameters, name))
      throw new Error(`Unknown node parameter: ${name}`);
  }
}
