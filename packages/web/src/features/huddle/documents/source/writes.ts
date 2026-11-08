import type { HuddleDraftBaseline } from '@puddle/shared';
import { baselineTarget, followsOwnWrite } from './revision';

/** One save at a time per captured huddle in this renderer; no retries after rejection. */
const queues = new Map<string, Promise<unknown>>();
const acknowledged = new Map<string, HuddleDraftBaseline>();
const key = (value: HuddleDraftBaseline) => `${baselineTarget(value)}:${value.digest}`;
export function afterOwnWrites(value: HuddleDraftBaseline, file: string): HuddleDraftBaseline {
  let current = value;
  for (let i = 0; i < 512; i++) {
    const next = acknowledged.get(key(current));
    // A sibling document may follow our acknowledged save, but a second view's
    // older draft of the same file must still conflict instead of overwriting it.
    if (!next || next.digest === current.digest || next.files[file] !== current.files[file]) break;
    current = next;
  }
  return current;
}
export function acknowledgeSourceWrite(
  before: HuddleDraftBaseline,
  after: HuddleDraftBaseline,
  file: string,
): void {
  if (before.digest === after.digest || !followsOwnWrite(before, after, file)) return;
  acknowledged.set(key(before), after);
  while (acknowledged.size > 512) acknowledged.delete(acknowledged.keys().next().value!);
}
export async function queueSourceWrite<T>(target: string, write: () => Promise<T>): Promise<T> {
  const previous = queues.get(target);
  const result = (previous ? previous.catch(() => {}) : Promise.resolve()).then(write);
  queues.set(target, result);
  try {
    return await result;
  } finally {
    if (queues.get(target) === result) queues.delete(target);
  }
}
