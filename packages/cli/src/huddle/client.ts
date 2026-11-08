import {
  huddleDiscoverySchema,
  huddleDocumentSchema,
  huddleToolDefinitionSchema,
  huddleToolLocationSchema,
  huddleValidationSchema,
  huddleOpenedSchema,
  huddleToolCreateSchema,
  supportsApplicationFeature,
  type HuddleLocation,
  type HuddleOpen,
  type HuddleCreate,
} from '@puddle/shared';
import { HuddleExecutionClient } from './execution/client.js';
import { huddleMutation } from './mutation.js';

/** Uses the same selected profile/authority as puddlang. Source and execution stay separate. */
export class HuddleClient {
  readonly supported: boolean;
  readonly execution: HuddleExecutionClient;
  constructor(
    private readonly request: (path: string, body?: unknown) => Promise<unknown>,
    protocol?: { major: number; minor: number },
  ) {
    this.supported = supportsApplicationFeature(protocol, { major: 27, minor: 1 });
    this.execution = new HuddleExecutionClient(request, protocol);
  }
  private requireSupported() {
    if (!this.supported)
      throw new Error(
        'Huddle source tools require a compatible daemon with inactive huddle authoring support',
      );
  }
  async list(raw: HuddleLocation) {
    this.requireSupported();
    const input = huddleToolLocationSchema.parse(raw);
    return huddleDiscoverySchema.parse(
      await this.request(`/definitions?${new URLSearchParams(input)}`),
    );
  }
  async inspect(raw: HuddleOpen) {
    this.requireSupported();
    const { huddle_id, ...location } = huddleToolDefinitionSchema.parse(raw);
    return huddleDocumentSchema.parse(
      await this.request(`/definitions/${huddle_id}?${new URLSearchParams(location)}`),
    );
  }
  async validate(input: HuddleOpen) {
    const document = await this.inspect(input);
    return huddleValidationSchema.parse({
      valid: !document.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
      digest: document.digest,
      diagnostics: document.diagnostics,
    });
  }
  async create(raw: HuddleCreate) {
    this.requireSupported();
    const input = huddleToolCreateSchema.parse(raw);
    return huddleMutation(
      'List saved huddles in this project/worktree before creating another.',
      async () => huddleOpenedSchema.parse(await this.request('/definitions', input)),
    );
  }
  async open(raw: HuddleOpen) {
    this.requireSupported();
    const input = huddleToolDefinitionSchema.parse(raw);
    return huddleMutation(
      'Inspect saved huddles and the session list before opening again.',
      async () => huddleOpenedSchema.parse(await this.request('/open', input)),
    );
  }
}
