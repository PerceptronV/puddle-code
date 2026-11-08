import { canonicalHuddleJson } from '../api/huddle/values.js';
import type { HuddleComponent } from '../api/huddle/components.js';
import type { HuddleJson } from '../api/huddle/values.js';
import { huddleDefinitionSchema, huddleLayoutSchema } from '../api/huddle/definitions.js';
import { huddleSourceSchema } from '../api/huddle/source.js';

/** Stable input to SHA-256, shared by capture and clients verifying an authoring baseline. */
export function huddleRevisionContent(
  files: Record<string, string>,
  components: Record<string, HuddleComponent>,
) {
  return canonicalHuddleJson({ format: 1, files, components: components as unknown as HuddleJson });
}

/** Hash verification is performed by the caller's Node or browser crypto implementation. */
export function parseHuddleSource(id: string, value: unknown) {
  const source = huddleSourceSchema.parse(value);
  const definition = huddleDefinitionSchema.parse(JSON.parse(source.files['huddle.json']!));
  const layout =
    source.files['layout.json'] === undefined
      ? undefined
      : huddleLayoutSchema.parse(JSON.parse(source.files['layout.json']));
  if (
    source.document.definition.id !== id ||
    canonicalHuddleJson(definition as unknown as HuddleJson) !==
      canonicalHuddleJson(source.document.definition as unknown as HuddleJson) ||
    canonicalHuddleJson((layout ?? null) as HuddleJson) !==
      canonicalHuddleJson((source.document.layout ?? null) as HuddleJson)
  )
    throw new Error('Huddle source returned another definition or layout');
  return source;
}
