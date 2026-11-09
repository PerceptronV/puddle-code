import {
  huddleDiscoverySchema,
  huddleDocumentSchema,
  huddleToolDefinitionSchema,
  huddleToolValidateSchema,
  huddleToolLocationSchema,
  huddleValidationSchema,
  huddleOpenedSchema,
  huddleToolCreateSchema,
  huddleToolDuplicateSchema,
  supportsApplicationFeature,
  type HuddleLocation,
  type HuddleOpen,
  type HuddleValidate,
  type HuddleCreate,
  type HuddleDuplicate,
} from '@puddle/shared';
import { HuddleExecutionClient } from './execution/client.js';
import { HuddlePlacementClient } from './placement/client.js';
import { huddleMutation } from './mutation.js';
import { HuddleSourceClient } from './source/client.js';

/** Uses the same selected profile/authority as puddlang. Source and execution stay separate. */
export class HuddleClient {
  readonly supported: boolean;
  readonly duplicationSupported: boolean;
  readonly startersSupported: boolean;
  readonly moduleValidationSupported: boolean;
  readonly execution: HuddleExecutionClient;
  readonly placement: HuddlePlacementClient;
  readonly source: HuddleSourceClient;
  constructor(
    private readonly request: (path: string, body?: unknown, method?: 'PUT') => Promise<unknown>,
    protocol?: { major: number; minor: number },
    sessionRequest?: (path: string, body?: unknown) => Promise<unknown>,
  ) {
    this.supported = supportsApplicationFeature(protocol, { major: 27, minor: 1 });
    this.duplicationSupported = supportsApplicationFeature(protocol, { major: 28, minor: 26 });
    this.startersSupported = supportsApplicationFeature(protocol, { major: 28, minor: 27 });
    this.moduleValidationSupported = supportsApplicationFeature(protocol, { major: 28, minor: 31 });
    this.execution = new HuddleExecutionClient(request, protocol);
    this.placement = new HuddlePlacementClient(request, sessionRequest, protocol);
    this.source = new HuddleSourceClient(request, protocol);
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
  async validate(raw: HuddleValidate) {
    this.requireSupported();
    const { huddle_id, ...location } = huddleToolValidateSchema.parse(raw);
    if (this.moduleValidationSupported)
      return huddleValidationSchema.parse(
        await this.request(`/definitions/${huddle_id}/validate`, location),
      );
    if (location.fixtures !== undefined)
      throw new Error('Module and fixture validation requires daemon protocol 28.31 or newer');
    const input = { project_id: location.project_id, worktree: location.worktree, huddle_id };
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
    if (input.template && !this.startersSupported)
      throw new Error('Huddle starters require daemon protocol 28.27 or newer');
    return huddleMutation(
      'List saved huddles in this project/worktree before creating another.',
      async () => huddleOpenedSchema.parse(await this.request('/definitions', input)),
    );
  }
  async duplicate(raw: HuddleDuplicate) {
    if (!this.duplicationSupported)
      throw new Error('Copying a huddle requires daemon protocol 28.26 or newer');
    const { huddle_id, ...input } = huddleToolDuplicateSchema.parse(raw);
    return huddleMutation(
      'List saved huddles in this project/worktree before copying again.',
      async () =>
        huddleOpenedSchema.parse(await this.request(`/definitions/${huddle_id}/duplicate`, input)),
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
