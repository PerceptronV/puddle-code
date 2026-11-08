import type { HuddleGitSnapshot } from '@puddle/shared';

export function gitChanges(before: HuddleGitSnapshot, after: HuddleGitSnapshot) {
  const oldRefs = new Map(before.map((item) => [item.ref, item]));
  const newRefs = new Map(after.map((item) => [item.ref, item]));
  return [...new Set([...oldRefs.keys(), ...newRefs.keys()])].sort().flatMap((ref) => {
    const old = oldRefs.get(ref),
      next = newRefs.get(ref);
    if (old && next && old.oid === next.oid && old.target === next.target) return [];
    return [
      {
        ref,
        oldOid: old?.oid ?? null,
        newOid: next?.oid ?? null,
        oldTarget: old?.target ?? null,
        newTarget: next?.target ?? null,
      },
    ];
  });
}
