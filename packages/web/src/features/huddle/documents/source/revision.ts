import {
  canonicalHuddleJson,
  huddleRevisionContent,
  parseHuddleSource,
  huddleDraftBaselineSchema,
  type HuddleDraftBaseline,
  type HuddleOpen,
  type HuddleSource,
  type HuddleJson,
} from '@puddle/shared';

const encoder = new TextEncoder();
export async function sourceHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function capturedSource(
  target: HuddleOpen & { profile: string; scope: string },
  value: unknown,
): Promise<{ source: HuddleSource; baseline: HuddleDraftBaseline }> {
  const source = parseHuddleSource(target.huddle_id, value);
  const digest = await sourceHash(huddleRevisionContent(source.files, source.document.components));
  if (digest !== source.document.digest)
    throw new Error('Huddle source does not match its captured digest');
  const hashEntries = async (entries: [string, string][]) =>
    Object.fromEntries(
      await Promise.all(entries.map(async ([name, text]) => [name, await sourceHash(text)])),
    );
  const [files, components] = await Promise.all([
    hashEntries(Object.entries(source.files)),
    hashEntries(
      Object.entries(source.document.components).map(([name, value]) => [
        name,
        canonicalHuddleJson(value as unknown as HuddleJson),
      ]),
    ),
  ]);
  return {
    source,
    baseline: huddleDraftBaselineSchema.parse({ ...target, format: 1, digest, files, components }),
  };
}

export function baselineTarget(
  baseline: Pick<
    HuddleDraftBaseline,
    'scope' | 'profile' | 'project_id' | 'worktree' | 'huddle_id'
  >,
): string {
  return JSON.stringify([
    baseline.scope,
    baseline.profile,
    baseline.project_id,
    baseline.worktree,
    baseline.huddle_id,
  ]);
}

/** Only our acknowledged write may advance another draft; unrelated existing source never does. */
export function followsOwnWrite(
  before: HuddleDraftBaseline,
  after: HuddleDraftBaseline,
  file: string,
): boolean {
  if (baselineTarget(before) !== baselineTarget(after)) return false;
  if (
    Object.entries(before.files).some(
      ([name, hash]) =>
        name !== file && after.files[name] !== undefined && after.files[name] !== hash,
    )
  )
    return false;
  if (file === 'huddle.json') return true; // new/removed dependencies follow this explicit manifest edit
  return (
    Object.entries(after.files).every(
      ([name, hash]) => name === file || before.files[name] === hash,
    ) &&
    Object.keys(before.files).every((name) => name === file || Object.hasOwn(after.files, name)) &&
    canonicalHuddleJson(before.components) === canonicalHuddleJson(after.components)
  );
}
