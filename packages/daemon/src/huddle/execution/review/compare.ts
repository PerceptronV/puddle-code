import { createHash } from 'node:crypto';
import {
  canonicalHuddleJson,
  type HuddleJson,
  type HuddleReviewEntry,
  type HuddleReview,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../definitions/capture.js';

/** Exact source bytes plus canonical resolved contracts. Never import a component module. */
export function compareHuddleRevisions(
  active: HuddleDefinitionSnapshot,
  saved?: HuddleDefinitionSnapshot,
  selected?: HuddleReviewEntry,
): Pick<HuddleReview, 'entries' | 'content'> {
  const entries: HuddleReview['entries'] = [];
  let content: HuddleReview['content'];
  const fingerprint = (text: string | undefined) =>
    text === undefined
      ? null
      : {
          digest: createHash('sha256').update(text).digest('hex'),
          bytes: Buffer.byteLength(text),
        };
  for (const kind of ['file', 'component'] as const) {
    const before = kind === 'file' ? active.files : active.components;
    const after = kind === 'file' ? saved?.files : saved?.components;
    for (const path of [...new Set([...Object.keys(before), ...Object.keys(after ?? {})])].sort()) {
      const value = (record: typeof before | undefined) => {
        if (!record || !Object.hasOwn(record, path)) return undefined;
        return kind === 'file'
          ? (record[path] as string)
          : canonicalHuddleJson(record[path] as unknown as HuddleJson);
      };
      const a = value(before),
        b = value(after);
      const entry = { kind, path };
      entries.push({
        entry,
        before: fingerprint(a),
        after: fingerprint(b),
        change: !saved
          ? 'retained'
          : a === b
            ? 'unchanged'
            : a === undefined
              ? 'added'
              : b === undefined
                ? 'removed'
                : 'modified',
      });
      if (selected?.kind === kind && selected.path === path)
        content = { entry, before: a ?? null, after: b ?? null };
    }
  }
  if (selected && !content)
    throw new Error('This entry is not part of the reviewed source closure');
  return { entries, ...(content ? { content } : {}) };
}
