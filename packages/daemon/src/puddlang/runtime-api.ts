import {
  puddlangRunnerInputSchema,
  type PuddlangOperation,
  type PuddlangHandle,
} from '@puddle/shared';
import { PuddlangAgent, createPuddlangClient } from './client.js';

export { z } from 'zod';
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

export class Agent extends PuddlangAgent {
  constructor(handle: PuddlangHandle) {
    super(handle, call);
  }
}
export const { spawn, attach } = createPuddlangClient(call, (handle) => new Agent(handle));
