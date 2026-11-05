import { describe, expect, it } from 'vitest';
import { panePathLabel } from '../../../src/features/workspace/panes/pane-path';

describe('single-pane path tooltip', () => {
  it('uses the complete path relative to the visible tree, including external browse roots', () => {
    expect(panePathLabel({ session: 's', path: 'src/deep/file.ts' }, '/repo', '/repo')).toBe(
      'src/deep/file.ts',
    );
    expect(
      panePathLabel(
        { session: 's', kind: 'external', root: '/other', path: 'src/file.ts' },
        '/other',
        '/other/src',
      ),
    ).toBe('file.ts');
  });
  it('shows absolute paths outside the visible tree, respecting segment boundaries', () => {
    expect(panePathLabel({ session: 's', path: 'file.ts' }, '/repo-copy', '/repo')).toBe(
      '/repo-copy/file.ts',
    );
    expect(panePathLabel({ session: 's', path: 'file.ts' }, '/repo', null)).toBe('/repo/file.ts');
  });
  it('retains an unsaved draft name without inventing a filesystem path', () => {
    expect(
      panePathLabel({ session: 's', kind: 'untitled', path: 'Untitled-1' }, undefined, '/repo'),
    ).toBe('Untitled-1');
  });
});
