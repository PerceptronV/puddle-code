import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  supportsHuddleRuntime,
  huddleFiletreeSettingsSchema,
} from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';
it('preserves older owners and prevents adopting Filetree ownership with an older candidate', () => {
  const { filetree: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(supportsHuddleRuntime(old)).toBe(true);
  expect(supportsHuddleRuntime({ ...old, filetree: 2 })).toBe(false);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, old)).toBe(true);
  candidate.roles.huddle = old;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});
it('rejects traversal and unbounded filter settings before observation', () => {
  const settings = {
    worktree: '/project',
    directory: '.',
    include: ['**/*'],
    exclude: [],
    outputPaths: [],
    debounceMs: 250,
    reconcileMs: 30000,
  };
  expect(huddleFiletreeSettingsSchema.safeParse(settings).success).toBe(true);
  for (const extra of [
    { directory: '../other' },
    { include: ['../**/*'] },
    { outputPaths: ['/tmp/report'] },
    { include: [] },
    { reconcileMs: 1 },
  ])
    expect(huddleFiletreeSettingsSchema.safeParse({ ...settings, ...extra }).success).toBe(false);
});
