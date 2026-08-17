import { describe, expect, it } from 'vitest';
import { fileTabRevealTarget } from '../src/features/explorer/file-tab-reveal';

describe('file-tab reveal target', () => {
  it('keeps a worktree file relative to its current worktree root', () => {
    expect(
      fileTabRevealTarget(
        { kind: 'file', session: 's1', path: 'packages/web/src/app.tsx' },
        '/worktrees/main',
      ),
    ).toEqual({ directory: '/worktrees/main', path: 'packages/web/src/app.tsx' });
  });

  it('rebases an external file to its containing directory', () => {
    expect(
      fileTabRevealTarget(
        { kind: 'external', session: 's1', root: '/Users/me', path: 'notes/todo.md' },
        '/worktrees/main',
      ),
    ).toEqual({
      directory: '/Users/me/notes',
      path: 'todo.md',
      browseRoot: '/Users/me/notes',
    });
  });

  it('keeps an external root-level file at its existing browse root', () => {
    expect(
      fileTabRevealTarget(
        { kind: 'external', session: 's1', root: '/', path: 'README.md' },
        '/worktrees/main',
      ),
    ).toEqual({ directory: '/', path: 'README.md', browseRoot: '/' });
  });
});
