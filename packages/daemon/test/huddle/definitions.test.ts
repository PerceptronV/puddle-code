import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as files from '../../src/huddle/definitions/files.js';
import { captureHuddleDefinition } from '../../src/huddle/definitions/capture.js';
import { discoverHuddleDefinitions } from '../../src/huddle/definitions/discovery.js';
import {
  manualHuddleFixture,
  reviewHuddleFixture,
  fixtureBuiltins,
} from '../../../shared/test/helpers/huddle.js';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function setup() {
  const worktree = await mkdtemp(join(tmpdir(), 'puddle-huddle-'));
  homes.push(worktree);
  const definition = manualHuddleFixture();
  const root = join(worktree, '.puddle/huddle', definition.id);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'huddle.json'), JSON.stringify(definition));
  return { worktree, definition, root };
}

describe('huddle definition discovery and source capture', () => {
  it('refuses a revision whose manifest changes during capture', async () => {
    const s = await setup();
    const read = files.readHuddleFile;
    let changed = false;
    vi.spyOn(files, 'readHuddleFile').mockImplementation(async (root, path) => {
      const text = await read(root, path);
      if (!changed && path === 'huddle.json') {
        changed = true;
        await writeFile(join(root, path), `${text}\n`);
      }
      return text;
    });
    await expect(
      captureHuddleDefinition(s.worktree, s.definition.id, fixtureBuiltins),
    ).rejects.toThrow('changed during capture');
  });
  it('discovers multiple independent ids and isolates a malformed sibling', async () => {
    const s = await setup();
    const otherId = randomBytes(16).toString('hex');
    const other = join(s.worktree, '.puddle/huddle', otherId);
    await mkdir(other);
    await writeFile(join(other, 'huddle.json'), '{');
    const entries = await discoverHuddleDefinitions(s.worktree, fixtureBuiltins);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.id === s.definition.id)?.name).toBe(s.definition.name);
    expect(entries.every((entry) => !('files' in entry) && !('snapshot' in entry))).toBe(true);
    expect(entries.find((e) => e.id === otherId)?.error).toBeTruthy();
  });

  it('retains deterministic source digests and changes them when source or builtin contracts change', async () => {
    const s = await setup();
    await writeFile(
      join(s.root, 'layout.json'),
      JSON.stringify({
        format: 1,
        nodes: {},
        labels: { [s.definition.nodes[0]!.id]: 'Manual launch' },
      }),
    );
    const first = await captureHuddleDefinition(s.worktree, s.definition.id, fixtureBuiltins);
    expect(first.diagnostics).toEqual([]);
    expect(first.layout?.labels).toEqual({ [s.definition.nodes[0]!.id]: 'Manual launch' });
    expect(first.definition).toEqual(s.definition);
    expect(
      (await captureHuddleDefinition(s.worktree, s.definition.id, fixtureBuiltins)).digest,
    ).toBe(first.digest);
    await writeFile(
      join(s.root, 'huddle.json'),
      JSON.stringify({ ...s.definition, name: 'Renamed' }),
    );
    expect(
      (await captureHuddleDefinition(s.worktree, s.definition.id, fixtureBuiltins)).digest,
    ).not.toBe(first.digest);
    const changed = new Map(
      [...fixtureBuiltins].map(([id, component]) => [id, { ...component, title: 'Updated' }]),
    );
    expect((await captureHuddleDefinition(s.worktree, s.definition.id, changed)).digest).not.toBe(
      (await captureHuddleDefinition(s.worktree, s.definition.id, fixtureBuiltins)).digest,
    );
  });

  it('captures declared local dependencies without evaluating top-level source', async () => {
    const s = await setup();
    const { definition, agent } = reviewHuddleFixture();
    await writeFile(join(s.root, 'huddle.json'), JSON.stringify(definition));
    for (const name of ['coder', 'reviewer']) {
      const directory = join(s.root, 'nodes', name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'node.json'),
        JSON.stringify({ ...agent, dependencies: ['./data.json'] }),
      );
      await writeFile(
        join(directory, 'run.ts'),
        'throw new Error("Discovery must not execute this source");',
      );
      await writeFile(join(directory, 'data.json'), '{"value":42}');
    }
    const snapshot = await captureHuddleDefinition(s.worktree, definition.id, fixtureBuiltins);
    expect(snapshot.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(snapshot.files['nodes/reviewer/data.json']).toBe('{"value":42}');
    expect(Object.keys(snapshot.files)).toHaveLength(7);
  });

  it('rejects mismatched identities, unsupported formats and oversized files', async () => {
    const s = await setup();
    await writeFile(
      join(s.root, 'huddle.json'),
      JSON.stringify({ ...s.definition, id: randomBytes(16).toString('hex') }),
    );
    await expect(captureHuddleDefinition(s.worktree, s.definition.id)).rejects.toThrow(
      'directory name',
    );
    await writeFile(join(s.root, 'huddle.json'), JSON.stringify({ ...s.definition, format: 2 }));
    await expect(captureHuddleDefinition(s.worktree, s.definition.id)).rejects.toThrow();
    await writeFile(join(s.root, 'huddle.json'), ' '.repeat(256 * 1024 + 1));
    await expect(captureHuddleDefinition(s.worktree, s.definition.id)).rejects.toThrow('at most');
  });

  it('rejects symlinked roots, manifests and component source escapes', async () => {
    const s = await setup();
    const id = randomBytes(16).toString('hex');
    await symlink(s.root, join(s.worktree, '.puddle/huddle', id));
    await expect(captureHuddleDefinition(s.worktree, id)).rejects.toThrow('symlink');
    await writeFile(join(s.worktree, 'external.json'), JSON.stringify(s.definition));
    await rm(join(s.root, 'huddle.json'));
    await symlink(join(s.worktree, 'external.json'), join(s.root, 'huddle.json'));
    await expect(captureHuddleDefinition(s.worktree, s.definition.id)).rejects.toThrow('symlink');
    await rm(join(s.root, 'huddle.json'));
    const { definition, agent } = reviewHuddleFixture();
    await writeFile(join(s.root, 'huddle.json'), JSON.stringify(definition));
    for (const name of ['coder', 'reviewer']) {
      const directory = join(s.root, 'nodes', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'node.json'), JSON.stringify(agent));
      await symlink(join(s.worktree, 'external.json'), join(directory, 'run.ts'));
    }
    const snapshot = await captureHuddleDefinition(s.worktree, s.definition.id, fixtureBuiltins);
    expect(snapshot.diagnostics.filter((d) => d.code === 'component_invalid')).toHaveLength(2);
    expect(snapshot.files['nodes/coder/run.ts']).toBeUndefined();
  });

  it('treats an absent collection as empty without creating files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'puddle-huddle-empty-'));
    homes.push(home);
    expect(await discoverHuddleDefinitions(home)).toEqual([]);
  });
});
