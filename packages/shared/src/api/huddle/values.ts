import { z } from 'zod';

export const HUDDLE_LIMITS = {
  nodes: 256,
  edges: 1024,
  ports: 64,
  files: 128,
  fileBytes: 256 * 1024,
  bundleBytes: 4 * 1024 * 1024,
  valueBytes: 256 * 1024,
  valueDepth: 16,
  valueEntries: 8192,
} as const;

export type HuddleJson =
  | null
  | boolean
  | number
  | string
  | HuddleJson[]
  | {
      [key: string]: HuddleJson;
    };

/** Bound traversal before recursive schema parsing, including inputs from local callers. */
export function isHuddleJson(value: unknown): value is HuddleJson {
  const pending = [{ value, depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++entries > HUDDLE_LIMITS.valueEntries || item.depth > HUDDLE_LIMITS.valueDepth)
      return false;
    if (item.value === null || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'string') {
      if (item.value.length > HUDDLE_LIMITS.valueBytes) return false;
      continue;
    }
    if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value)) return false;
      continue;
    }
    // Cycles fail the depth/entry bound; repeated non-cyclic values remain valid JSON.
    if (typeof item.value !== 'object') return false;
    if (
      !Array.isArray(item.value) &&
      Object.getPrototypeOf(item.value) !== Object.prototype &&
      Object.getPrototypeOf(item.value) !== null
    )
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(item.value);
    if (Reflect.ownKeys(descriptors).length > HUDDLE_LIMITS.valueEntries) return false;
    if (Array.isArray(item.value) && Object.keys(descriptors).length !== item.value.length + 1)
      return false;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return false;
      if (Array.isArray(item.value) && key === 'length') continue;
      if (Array.isArray(item.value) && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !('value' in descriptor)) return false;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
    if (pending.length > HUDDLE_LIMITS.valueEntries) return false;
  }
  return new TextEncoder().encode(JSON.stringify(value)).length <= HUDDLE_LIMITS.valueBytes;
}

export const huddleJsonSchema = z.custom<HuddleJson>(isHuddleJson, 'Expected bounded JSON data');
export const huddleIdSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/, 'Expected a 32-character lowercase hex huddle id');
export const huddleKeySchema = z
  .string()
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  .refine((key) => !['__proto__', 'prototype', 'constructor'].includes(key), 'Reserved identifier');
export const huddleRelativePathSchema = z
  .string()
  .max(1024)
  .refine((path) => {
    const segments = path.replace(/^\.\//, '').split('/');
    return (
      !path.includes('\\') &&
      ![...path].some((character) => character.charCodeAt(0) < 32) &&
      segments.every((part) => part !== '' && part !== '.' && part !== '..')
    );
  }, 'Expected a relative path without traversal');

/** Stable encoding for contract comparison and revision hashes; never evaluates source. */
export function canonicalHuddleJson(value: HuddleJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalHuddleJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalHuddleJson(value[key]!)}`)
    .join(',')}}`;
}
