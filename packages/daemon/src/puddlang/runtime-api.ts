import { z } from 'zod';
import {
  puddlangRunnerInputSchema,
  puddlangHandleSchema,
  type PuddlangOperation,
  type PuddlangSpawn,
  type PuddlangHandle,
} from '@puddle/shared';

export { z };
export let input: unknown;
export function setInput(value: unknown): void {
  input = value;
}
let next = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
process.on('message', (raw) => {
  const parsed = puddlangRunnerInputSchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== 'reply') return;
  const message = parsed.data;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request?.reject(new Error(message.error));
  else request?.resolve(message.value);
});
process.on('disconnect', () => {
  for (const request of pending.values()) request.reject(new Error('Puddlang runner disconnected'));
  pending.clear();
});
function call(operation: PuddlangOperation): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error('Run this program with pudl run'));
      return;
    }
    const id = ++next;
    pending.set(id, { resolve, reject });
    process.send({ type: 'operation', id, operation }, (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
  });
}

export class Agent {
  constructor(readonly handle: PuddlangHandle) {}
  ask(prompt: string): Promise<string>;
  ask<T>(request: { prompt: string; input?: unknown; schema: z.ZodType<T> }): Promise<T>;
  async ask<T>(
    request: string | { prompt: string; input?: unknown; schema: z.ZodType<T> },
  ): Promise<string | T> {
    const prompt =
      typeof request === 'string'
        ? request
        : request.prompt +
          (request.input === undefined ? '' : `\n\nInput:\n${JSON.stringify(request.input)}`);
    const outputSchema = typeof request === 'string' ? undefined : z.toJSONSchema(request.schema);
    const reply = await call({
      op: 'ask',
      handle: this.handle,
      request: {
        prompt,
        ...(outputSchema ? { output_schema: outputSchema } : {}),
      },
    });
    if (typeof reply !== 'string') throw new Error('Agent returned an invalid reply');
    return typeof request === 'string' ? reply : request.schema.parse(JSON.parse(reply));
  }
  async stop(): Promise<void> {
    await call({ op: 'stop', handle: this.handle });
  }
}
export async function spawn(options: PuddlangSpawn): Promise<Agent> {
  return new Agent(puddlangHandleSchema.parse(await call({ op: 'spawn', options })));
}
export async function attach(reference: string): Promise<Agent> {
  return new Agent(puddlangHandleSchema.parse(await call({ op: 'attach', reference })));
}
