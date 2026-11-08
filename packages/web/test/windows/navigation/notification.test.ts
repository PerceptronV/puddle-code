import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(),
  fetch: vi.fn(),
  route: vi.fn(),
  command: vi.fn(),
}));
vi.mock('../../../src/lib/desktop', () => ({ desktopBridge: mocks.desktop }));
vi.mock('../../../src/lib/queries/client', () => ({ queryClient: { fetchQuery: mocks.fetch } }));
vi.mock('../../../src/features/windows/navigation/project-actions', () => ({
  handleProjectCommand: mocks.command,
}));
import { openNativeNotification } from '../../../src/features/windows/navigation/notification';

const target = { project: '1111111111', session: '00000000-0000-4000-8000-000000000001' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop.mockReturnValue({ windows: { projects: { route: mocks.route } } });
  mocks.fetch.mockResolvedValue({ project: { profile_id: 'aaaaaaaaaa' } });
});

it('routes a notification using the target project profile, not the receiving pane profile', async () => {
  mocks.route.mockResolvedValue(true);
  expect(await openNativeNotification(target)).toBe(true);
  expect(mocks.route).toHaveBeenCalledWith({
    profileId: 'aaaaaaaaaa',
    route: `/project/${target.project}/session/${target.session}`,
  });
  expect(mocks.command).not.toHaveBeenCalled();
});

it('activates the exact session locally when native routing keeps the host destination', async () => {
  mocks.route.mockResolvedValue(false);
  await openNativeNotification(target);
  expect(mocks.command).toHaveBeenCalledWith({
    kind: 'navigate-project',
    profileId: 'aaaaaaaaaa',
    route: `/project/${target.project}/session/${target.session}`,
  });
});

it('focuses an existing detached session pane before opening another project presentation', async () => {
  const focus = vi.fn().mockResolvedValue(true);
  mocks.desktop.mockReturnValue({
    windows: { projects: { route: mocks.route }, transfers: { focusPane: focus } },
  });
  expect(await openNativeNotification(target)).toBe(true);
  expect(focus).toHaveBeenCalledWith({
    profileId: 'aaaaaaaaaa',
    ref: { type: 'terminal', session: target.session },
  });
  expect(mocks.route).not.toHaveBeenCalled();
  expect(mocks.command).not.toHaveBeenCalled();
});

it('leaves browser and remote-host notification routing to their existing handlers', async () => {
  expect(await openNativeNotification({ ...target, host: crypto.randomUUID() })).toBe(false);
  mocks.desktop.mockReturnValue(undefined);
  expect(await openNativeNotification(target)).toBe(false);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it('does not navigate with a guessed profile after failed inspection', async () => {
  mocks.fetch.mockRejectedValue(new Error('offline'));
  await expect(openNativeNotification(target)).rejects.toThrow('offline');
  expect(mocks.route).not.toHaveBeenCalled();
  expect(mocks.command).not.toHaveBeenCalled();
});
