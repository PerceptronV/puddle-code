import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  supportsHuddleRuntime,
  huddleGitSettingsSchema,
} from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';
it('preserves older owners and prevents adopting Git ownership with an older candidate', () => {
  const { git: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(supportsHuddleRuntime(old)).toBe(true);
  expect(supportsHuddleRuntime({ ...old, git: 2 })).toBe(false);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, old)).toBe(true);
  candidate.roles.huddle = old;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});
it('rejects traversal and unbounded filter settings before observation', () => {
  const settings = {
    worktree: '/project',
    repository: '.',
    refs: ['refs/heads/**', 'refs/tags/**'],
    head: true,
    debounceMs: 250,
    reconcileMs: 30000,
  };
  expect(huddleGitSettingsSchema.safeParse(settings).success).toBe(true);
  for (const extra of [
    { repository: '../other' },
    { refs: ['refs/heads/../../**'] },
    { refs: ['refs/notes/**'] },
    { refs: [], head: false },
    { reconcileMs: 1 },
  ])
    expect(huddleGitSettingsSchema.safeParse({ ...settings, ...extra }).success).toBe(false);
});
