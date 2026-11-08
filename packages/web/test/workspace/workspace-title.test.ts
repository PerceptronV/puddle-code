import { describe, expect, it } from 'vitest';
import { workspaceTitle } from '../../src/features/workspace/workspace-title';

describe('workspace title', () => {
  it('shows only the project name for a workspace', () => {
    expect(workspaceTitle('My project')).toBe('My project');
  });

  it('uses the active file name in a pane window', () => {
    expect(
      workspaceTitle('My project', {
        type: 'editor',
        tab: { session: 's', path: 'src/main.ts' },
      }),
    ).toBe('main.ts');
  });

  it('uses the active session name or its existing short identity fallback', () => {
    const tab = { type: 'terminal' as const, session: '12345678-unknown' };
    expect(workspaceTitle('My project', tab, 'Investigate retries')).toBe('Investigate retries');
    expect(workspaceTitle('My project', tab)).toBe('12345678');
  });
});
