import { z } from 'zod';
import {
  puddlangHandleSchema,
  type PuddlangOperation,
  type PuddlangSpawn,
  type PuddlangHandle,
} from '@puddle/shared';

export type PuddlangCall = (operation: PuddlangOperation) => Promise<unknown>;

/** Provider-neutral API shared by the single-file runner and huddle workers. */
export class PuddlangAgent {
  constructor(
    readonly handle: PuddlangHandle,
    private readonly call: PuddlangCall,
  ) {}
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
    const reply = await this.call({
      op: 'ask',
      handle: this.handle,
      request: { prompt, ...(outputSchema ? { output_schema: outputSchema } : {}) },
    });
    if (typeof reply !== 'string') throw new Error('Agent returned an invalid reply');
    return typeof request === 'string' ? reply : request.schema.parse(JSON.parse(reply));
  }
  async stop(): Promise<void> {
    await this.call({ op: 'stop', handle: this.handle });
  }
}

export function createPuddlangClient(
  call: PuddlangCall,
  agent = (handle: PuddlangHandle) => new PuddlangAgent(handle, call),
) {
  return Object.freeze({
    async resume(reference: string): Promise<PuddlangAgent> {
      return agent(puddlangHandleSchema.parse(await call({ op: 'resume', reference })));
    },
    async restart(reference: string): Promise<PuddlangAgent> {
      return agent(puddlangHandleSchema.parse(await call({ op: 'restart', reference })));
    },
    async spawn(options: PuddlangSpawn): Promise<PuddlangAgent> {
      return agent(puddlangHandleSchema.parse(await call({ op: 'spawn', options })));
    },
    async attach(reference: string): Promise<PuddlangAgent> {
      return agent(puddlangHandleSchema.parse(await call({ op: 'attach', reference })));
    },
  });
}
export type PuddlangClient = ReturnType<typeof createPuddlangClient>;
