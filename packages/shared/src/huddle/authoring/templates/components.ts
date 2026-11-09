import { huddleComponentSchema } from '../../../api/huddle/components.js';
import { transformComponent } from '../../templates/flow/transform.js';

export const authoringComponents = {
  transform: transformComponent,
  feed: huddleComponentSchema.parse({
    format: 1,
    id: 'project.trigger.feed',
    version: 1,
    category: 'trigger',
    title: 'Pull feed',
    entry: './trigger.ts',
    dependencies: ['./http.ts'],
    trigger: { resume: 'continue' },
    capabilities: ['network'],
    parameters: {
      url: { schema: { type: 'string', minLength: 1 }, editor: 'text' },
      intervalMs: {
        schema: { type: 'integer', minimum: 15000, maximum: 86400000 },
        editor: 'number',
        default: 60000,
      },
    },
    outputs: { event: { schema: {}, emission: 'event' } },
  }),
  report: huddleComponentSchema.parse({
    format: 1,
    id: 'project.readout.report',
    version: 1,
    category: 'readout',
    title: 'Send report',
    entry: './readout.ts',
    dependencies: ['./http.ts'],
    capabilities: ['network'],
    readout: { idempotent: false, reconciliation: 'none', cancellation: 'signal' },
    parameters: { endpoint: { schema: { type: 'string', minLength: 1 }, editor: 'text' } },
    inputs: { value: { schema: {} } },
    outputs: { completed: { schema: {} } },
  }),
};

export const boundedHttpSource = `/** Bound response bytes before JSON parsing; pass a deadline/abort signal to fetch. */
export async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new Error('Response exceeds 256 KiB');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
`;

export const feedSource = `import { HuddleTrigger } from 'puddlang/huddle';
import { z } from 'zod';
import { readJson } from './http.ts';

const pageSchema = z.strictObject({
  gap: z.boolean(), cursor: z.string().max(4096),
  events: z.array(z.strictObject({
    id: z.string().min(1).max(256), cursor: z.string().max(4096), data: z.json(),
  })).max(16),
});

export default HuddleTrigger({
  contract: './node.json',
  async open(context, initialCursor) {
    let cursor = initialCursor;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve();
    const closing = new AbortController();
    const signal = AbortSignal.any([context.signal, closing.signal]);
    async function poll() {
      try {
        const url = new URL(String(context.parameters.url));
        if (cursor !== null) url.searchParams.set('after', String(cursor));
        const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) throw new Error('Feed returned ' + response.status);
        const page = pageSchema.parse(await readJson(response));
        if (page.gap) {
          closed = true;
          await context.health({ state: 'gap', message: 'Feed history expired', after: cursor });
          return;
        }
        for (const event of page.events) {
          await context.emit({ id: event.id, port: 'event', data: event.data, nextCursor: event.cursor });
          cursor = event.cursor;
        }
        // Only advance page progress after every emission has been acknowledged.
        await context.checkpoint(page.cursor);
        cursor = page.cursor;
        await context.health({ state: 'ready' });
      } catch (error) {
        if (!closed && !signal.aborted)
          await context.health({ state: 'degraded', message: String(error).slice(0, 4096) });
      }
    }
    function schedule() {
      if (closed || signal.aborted) return;
      timer = setTimeout(() => { pending = poll().finally(schedule); }, Number(context.parameters.intervalMs));
    }
    await poll();
    schedule();
    return { async close() {
      closed = true;
      closing.abort();
      clearTimeout(timer);
      await pending;
    } };
  },
});
`;

export const reportSource = `import { HuddleReadout } from 'puddlang/huddle';
import { z } from 'zod';
import { readJson } from './http.ts';

const confirmation = z.strictObject({ accepted: z.literal(true), receipt: z.json() });
export default HuddleReadout({
  contract: './node.json',
  async deliver(context, delivery) {
    try {
      const response = await fetch(String(context.parameters.endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': delivery.idempotencyKey },
        body: JSON.stringify(delivery.inputs.value),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
      });
      // An error or absent receipt does not prove that the destination refused delivery.
      if (!response.ok) return { status: 'unknown', message: 'Destination did not confirm delivery' };
      const { receipt } = confirmation.parse(await readJson(response));
      return { status: 'delivered', receipt, outputs: { completed: receipt } };
    } catch {
      return { status: 'unknown', message: 'Delivery reply unavailable or invalid' };
    }
  },
});
`;
