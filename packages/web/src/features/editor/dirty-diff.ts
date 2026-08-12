/** Public subset of Monaco's `ILineChange`, kept DOM/Monaco-free for tests. */
export interface DirtyLineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

export type DirtyDecorationKind = 'added' | 'modified' | 'deleted-before' | 'deleted-after';

export interface DirtyDecoration {
  startLineNumber: number;
  endLineNumber: number;
  kind: DirtyDecorationKind;
}

function count(start: number, end: number): number {
  return end === 0 ? 0 : Math.max(0, end - start + 1);
}

function deletionAt(line: number, lineCount: number): DirtyDecoration {
  if (line > lineCount) {
    return {
      startLineNumber: Math.max(1, lineCount),
      endLineNumber: Math.max(1, lineCount),
      kind: 'deleted-after',
    };
  }
  const target = Math.max(1, line);
  return { startLineNumber: target, endLineNumber: target, kind: 'deleted-before' };
}

/**
 * Map Monaco line changes to VS Code-style bars and deletion triangles.
 * Replacements pair lines as modified, then expose surplus lines in their
 * actual direction rather than colouring the entire block alike.
 */
export function dirtyDecorations(
  changes: readonly DirtyLineChange[],
  modifiedLineCount: number,
): DirtyDecoration[] {
  const decorations: DirtyDecoration[] = [];
  for (const change of changes) {
    const originalCount = count(change.originalStartLineNumber, change.originalEndLineNumber);
    const modifiedCount = count(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
    if (originalCount === 0 && modifiedCount > 0) {
      decorations.push({
        startLineNumber: change.modifiedStartLineNumber,
        endLineNumber: change.modifiedEndLineNumber,
        kind: 'added',
      });
      continue;
    }
    if (modifiedCount === 0 && originalCount > 0) {
      decorations.push(deletionAt(change.modifiedStartLineNumber, modifiedLineCount));
      continue;
    }

    const paired = Math.min(originalCount, modifiedCount);
    if (paired > 0) {
      decorations.push({
        startLineNumber: change.modifiedStartLineNumber,
        endLineNumber: change.modifiedStartLineNumber + paired - 1,
        kind: 'modified',
      });
    }
    if (modifiedCount > paired) {
      decorations.push({
        startLineNumber: change.modifiedStartLineNumber + paired,
        endLineNumber: change.modifiedEndLineNumber,
        kind: 'added',
      });
    }
    if (originalCount > paired) {
      decorations.push(
        deletionAt(change.modifiedStartLineNumber + modifiedCount, modifiedLineCount),
      );
    }
  }
  return decorations;
}
