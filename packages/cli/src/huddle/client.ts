import {
  huddleDiscoverySchema,
  huddleDocumentSchema,
  huddleToolDefinitionSchema,
  huddleToolLocationSchema,
  huddleValidationSchema,
  supportsApplicationFeature,
  type HuddleLocation,
  type HuddleOpen,
} from '@puddle/shared';

/** Uses the same selected profile/authority as puddlang, with read-only source routes. */
export class HuddleClient {
  readonly supported: boolean;
  constructor(
    private readonly get: (path: string) => Promise<unknown>,
    protocol?: { major: number; minor: number },
  ) {
    this.supported = supportsApplicationFeature(protocol, { major: 27, minor: 1 });
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
      await this.get(`/definitions?${new URLSearchParams(input)}`),
    );
  }
  async inspect(raw: HuddleOpen) {
    this.requireSupported();
    const { huddle_id, ...location } = huddleToolDefinitionSchema.parse(raw);
    return huddleDocumentSchema.parse(
      await this.get(`/definitions/${huddle_id}?${new URLSearchParams(location)}`),
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
}
