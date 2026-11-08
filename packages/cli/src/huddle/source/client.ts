import { createHash } from 'node:crypto';
import {
  huddleToolDefinitionSchema,
  huddleToolSaveSourceSchema,
  supportsApplicationFeature,
  parseHuddleSource,
  huddleRevisionContent,
  type HuddleOpen,
  type HuddleSaveSource,
} from '@puddle/shared';
import { huddleMutation } from '../mutation.js';

export class HuddleSourceClient {
  readonly supported: boolean;
  constructor(
    private readonly request: (path: string, body?: unknown, method?: 'PUT') => Promise<unknown>,
    protocol?: { major: number; minor: number },
  ) {
    this.supported = supportsApplicationFeature(protocol, { major: 28, minor: 11 });
  }
  private requireSupported() {
    if (!this.supported)
      throw new Error('Huddle captured source requires daemon protocol 28.11 or newer');
  }
  private parse(id: string, value: unknown) {
    const source = parseHuddleSource(id, value);
    const digest = createHash('sha256')
      .update(huddleRevisionContent(source.files, source.document.components))
      .digest('hex');
    if (digest !== source.document.digest)
      throw new Error('Huddle source digest does not match its captured files/contracts');
    return source;
  }
  async read(raw: HuddleOpen) {
    this.requireSupported();
    const { huddle_id, ...location } = huddleToolDefinitionSchema.parse(raw);
    return this.parse(
      huddle_id,
      await this.request(`/definitions/${huddle_id}/source?${new URLSearchParams(location)}`),
    );
  }
  async save(raw: HuddleSaveSource) {
    this.requireSupported();
    const { huddle_id, ...request } = huddleToolSaveSourceSchema.parse(raw);
    return huddleMutation(
      'Read huddle source and reconcile the retained draft before another save.',
      async () => {
        const source = this.parse(
          huddle_id,
          await this.request(`/definitions/${huddle_id}/source`, request, 'PUT'),
        );
        if (source.files[request.edit.file] !== request.edit.content)
          throw new Error('Huddle source changed after publication');
        return source;
      },
    );
  }
}
