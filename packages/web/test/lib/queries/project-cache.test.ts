import { expect, it } from 'vitest';
import type { Project } from '@puddle/shared';
import { ProjectListCache, remoteProjectScope } from '../../../src/lib/queries/project-cache';

const project: Project = {
  id: '0123456789',
  profile_id: 'abcdef0123',
  repo_id: 1,
  name: 'Project',
  abbrev: null,
  archived: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
function fixture() {
  let value: string | null = null;
  let now = 1000;
  const cache = new ProjectListCache(
    () => ({
      getItem: () => value,
      setItem: (_key, next) => {
        value = next;
      },
      removeItem: () => {
        value = null;
      },
    }),
    () => now,
  );
  return {
    cache,
    value: () => value,
    corrupt: (next: string) => {
      value = next;
    },
    advance: () => {
      now += 8 * 24 * 60 * 60 * 1000;
    },
  };
}

it('isolates services, accounts, hosts and host identity replacements', () => {
  const { cache } = fixture();
  const host = {
    service: 'https://remote.test',
    account: 'one',
    host: 'host',
    peer: 'trusted-key',
  };
  const scope = remoteProjectScope(host);
  cache.write(scope, [project]);
  expect(cache.read(scope)).toEqual([project]);
  for (const field of ['service', 'account', 'host', 'peer'] as const)
    expect(cache.read(remoteProjectScope({ ...host, [field]: 'different' }))).toBeUndefined();
  cache.forget(scope);
  expect(cache.read(scope)).toBeUndefined();
});

it('filters the full list by profile, replaces empty results and expires old data', () => {
  const { cache, advance } = fixture();
  cache.write('host', [project]);
  expect(cache.read('host', project.profile_id)).toEqual([project]);
  expect(cache.read('host', 'other')).toEqual([]);
  cache.write('host', []);
  expect(cache.read('host')).toEqual([]);
  cache.write('host', [project], project.profile_id);
  cache.write('host', [project], 'other');
  expect(cache.read('host', 'other')).toBeUndefined();
  advance();
  expect(cache.read('host')).toBeUndefined();
});

it('bounds retained lists and bytes, rejects malformed storage and tolerates storage denial', () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) f.cache.write(`host-${i}`, [project]);
  expect(f.cache.read('host-0')).toBeUndefined();
  expect(f.cache.read('host-49')).toEqual([project]);
  expect(f.value()!.length * 2).toBeLessThanOrEqual(1024 * 1024);
  f.cache.write('oversize', [{ ...project, name: 'x'.repeat(256 * 1024) }]);
  expect(f.cache.read('oversize')).toBeUndefined();
  for (const bad of ['null', '{}', 'not json', '[{"scope":"host","at":1000,"projects":[{}]}]']) {
    f.corrupt(bad);
    expect(f.cache.read('host')).toBeUndefined();
  }
  const denied = new ProjectListCache(() => {
    throw new Error('denied');
  });
  expect(() => denied.write('host', [project])).not.toThrow();
  expect(denied.read('host')).toBeUndefined();
});
