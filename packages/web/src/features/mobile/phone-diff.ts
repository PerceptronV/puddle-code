import { diffWordsWithSpace, structuredPatch } from 'diff';

export interface DiffLine {
  number: number;
  changed: boolean;
  spans: { text: string; changed: boolean }[];
}

/** Bounded, escaped-text review. No editor models or executable source enter this view. */
export function phoneDiff(before: string, after: string) {
  const patch = structuredPatch('', '', before, after, '', '', { context: 3, timeout: 100 });
  if (!patch) return null;
  if (patch.hunks.reduce((count, hunk) => count + hunk.lines.length, 0) > 5_000) return null;
  const highlightDeadline = performance.now() + 30;
  let additions = 0;
  let deletions = 0;
  const hunks = patch.hunks.map((hunk) => {
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    const original: DiffLine[] = [];
    const modified: DiffLine[] = [];
    let removed: DiffLine[] = [];
    let added: DiffLine[] = [];
    const highlight = () => {
      // Pair replacement lines; keep whole-line highlights for unmatched/very long lines.
      for (let index = 0; index < Math.min(removed.length, added.length); index++) {
        const oldLine = removed[index]!;
        const newLine = added[index]!;
        const left = oldLine.spans[0]!.text;
        const right = newLine.spans[0]!.text;
        if (left.length + right.length > 4_000 || performance.now() >= highlightDeadline) continue;
        const words = diffWordsWithSpace(left, right, { timeout: 5 });
        if (!words) continue;
        oldLine.spans = words
          .filter((word) => !word.added)
          .map((word) => ({ text: word.value, changed: word.removed }));
        newLine.spans = words
          .filter((word) => !word.removed)
          .map((word) => ({ text: word.value, changed: word.added }));
      }
      removed = [];
      added = [];
    };
    for (const line of hunk.lines) {
      const prefix = line[0];
      if (prefix === '\\') continue; // Git's missing-final-newline annotation is not source.
      if (prefix === ' ') highlight();
      const makeLine = (number: number, changed: boolean): DiffLine => ({
        number,
        changed,
        spans: [{ text: line.slice(1), changed }],
      });
      if (prefix !== '+') {
        const entry = makeLine(oldNumber++, prefix === '-');
        original.push(entry);
        if (entry.changed) {
          removed.push(entry);
          deletions++;
        }
      }
      if (prefix !== '-') {
        const entry = makeLine(newNumber++, prefix === '+');
        modified.push(entry);
        if (entry.changed) {
          added.push(entry);
          additions++;
        }
      }
    }
    highlight();
    return { before: original, after: modified };
  });
  return { hunks, additions, deletions };
}
