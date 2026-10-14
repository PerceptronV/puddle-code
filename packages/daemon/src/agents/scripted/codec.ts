import type { LifecycleLaunchContext } from '../adapter.js';

export type JsonRecord = Record<string, unknown>;
export const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};

export interface TurnEvent {
  ref?: string;
  text?: string;
  reply?: string;
  complete?: boolean;
  error?: string;
}

/** Native flags and event interpretation belong to the provider. */
export interface ScriptedDriver {
  binary: string;
  env: Record<string, string>;
  command(
    ref: string | undefined,
    prompt: string,
    schema?: JsonRecord,
  ): {
    args: string[];
    stdin: string;
    env?: Record<string, string>;
  };
  decoder(): (event: JsonRecord) => TurnEvent;
}

export function schemaPrompt(prompt: string, schema?: JsonRecord): string {
  return schema
    ? `${prompt}\n\nReturn only JSON matching this schema, without Markdown fences:\n${JSON.stringify(schema)}`
    : prompt;
}

export type ScriptedContext = LifecycleLaunchContext;
