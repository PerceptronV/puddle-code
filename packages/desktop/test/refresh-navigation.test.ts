import { describe, expect, it, vi } from 'vitest';
import { refreshNavigation } from '../src/refresh-navigation.js';

describe('desktop refresh navigation', () => {
  it('leaves correlated same-origin readiness to the renderer and reloads menu requests', () => {
    const next = { origin: 'http://localhost:7433', createInvitation: vi.fn() };
    const route = next.origin + '/workspace/project?pane=files';
    expect(refreshNavigation(route, next.origin, next, 'correlation')).toBeNull();
    expect(refreshNavigation(route, next.origin, next)).toBe(route);
    expect(next.createInvitation).not.toHaveBeenCalled();
  });
  it('preserves navigation with a fresh invitation when the origin moves', () => {
    const next = {
      origin: 'http://localhost:7435',
      createInvitation: () => 'http://localhost:7435/?host=test%40fixture#invite=fresh',
    };
    expect(
      refreshNavigation(
        'http://localhost:7433/workspace/project?pane=files#token=obsolete',
        'http://localhost:7433',
        next,
        'correlation',
      ),
    ).toBe('http://localhost:7435/workspace/project?pane=files&host=test%40fixture#invite=fresh');
  });
});
