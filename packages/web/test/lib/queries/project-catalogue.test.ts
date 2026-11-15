import { expect, it, vi } from 'vitest';
import { loadProjectCatalogue } from '../../../src/lib/queries/project-catalogue';

const project = {
  id: '0123456789',
  profile_id: 'abcdef0123',
  repo_id: 1,
  name: 'Project',
  abbrev: null,
  archived: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const catalogue = {
  projects: [
    {
      project,
      repo_path: '/repo',
      sessions: { total: 10, running: 1, waiting_input: 2, interrupted: 3 },
    },
  ],
  project_order: {},
};

it('loads counts, paths and ordered navigation in a single request on capable hosts', async () => {
  const read = vi.fn(async () => catalogue);
  const publish = vi.fn();
  await loadProjectCatalogue(read, true, () => true, publish);
  expect(read).toHaveBeenCalledExactlyOnceWith('/api/projects/catalogue');
  expect(publish).toHaveBeenCalledExactlyOnceWith({
    projects: [project],
    paths: { 1: '/repo' },
    counts: { [project.id]: catalogue.projects[0]!.sessions },
  });
});

it('publishes legacy navigation before slow supporting reads and tolerates their failures', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(async (path: string) => {
    if (path === '/api/projects') return [project];
    await pending;
    throw new Error('supporting request failed');
  });
  const publish = vi.fn();
  const loading = loadProjectCatalogue(read, false, () => true, publish);
  await Promise.resolve();
  expect(publish).toHaveBeenCalledExactlyOnceWith({ projects: [project], paths: {}, counts: {} });
  release();
  await loading;
  expect(publish).toHaveBeenCalledOnce();
});

it('discards catalogue replies after a host or connection generation changes', async () => {
  const publish = vi.fn();
  await loadProjectCatalogue(
    async () => catalogue,
    true,
    () => false,
    publish,
  );
  expect(publish).not.toHaveBeenCalled();
});
