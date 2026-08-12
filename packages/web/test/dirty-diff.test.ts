import { describe, expect, it } from 'vitest';
import { dirtyDecorations } from '../src/features/editor/dirty-diff';

describe('dirty diff decoration mapping', () => {
  it('maps additions and replacements with surplus inserted lines', () => {
    expect(
      dirtyDecorations(
        [
          {
            originalStartLineNumber: 2,
            originalEndLineNumber: 0,
            modifiedStartLineNumber: 2,
            modifiedEndLineNumber: 3,
          },
          {
            originalStartLineNumber: 5,
            originalEndLineNumber: 5,
            modifiedStartLineNumber: 6,
            modifiedEndLineNumber: 8,
          },
        ],
        8,
      ),
    ).toEqual([
      { startLineNumber: 2, endLineNumber: 3, kind: 'added' },
      { startLineNumber: 6, endLineNumber: 6, kind: 'modified' },
      { startLineNumber: 7, endLineNumber: 8, kind: 'added' },
    ]);
  });

  it('places deletion triangles between lines and at both file boundaries', () => {
    expect(
      dirtyDecorations(
        [
          {
            originalStartLineNumber: 1,
            originalEndLineNumber: 1,
            modifiedStartLineNumber: 1,
            modifiedEndLineNumber: 0,
          },
          {
            originalStartLineNumber: 4,
            originalEndLineNumber: 4,
            modifiedStartLineNumber: 3,
            modifiedEndLineNumber: 0,
          },
          {
            originalStartLineNumber: 8,
            originalEndLineNumber: 8,
            modifiedStartLineNumber: 7,
            modifiedEndLineNumber: 0,
          },
        ],
        6,
      ),
    ).toEqual([
      { startLineNumber: 1, endLineNumber: 1, kind: 'deleted-before' },
      { startLineNumber: 3, endLineNumber: 3, kind: 'deleted-before' },
      { startLineNumber: 6, endLineNumber: 6, kind: 'deleted-after' },
    ]);
  });

  it('marks surplus replacement deletions after the modified portion', () => {
    expect(
      dirtyDecorations(
        [
          {
            originalStartLineNumber: 2,
            originalEndLineNumber: 5,
            modifiedStartLineNumber: 2,
            modifiedEndLineNumber: 3,
          },
        ],
        5,
      ),
    ).toEqual([
      { startLineNumber: 2, endLineNumber: 3, kind: 'modified' },
      { startLineNumber: 4, endLineNumber: 4, kind: 'deleted-before' },
    ]);
  });
});
