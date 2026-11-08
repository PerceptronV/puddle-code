import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { huddleReviewSchema } from '@puddle/shared';
import { huddleExecutionFixture as fixture } from '../../helpers/huddle/execution.js';

it('compares exact source and contracts without execution, and rejects stale digests/activations', async () => {
  const f = await fixture();
  try {
    const saved = await f.source();
    const started = await f.request('start', { expected_digest: saved.digest, variables: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const target = started.body.owner.target;
    const read = await f.request('revision', {
      target,
      entry: { kind: 'file', path: 'nodes/example/run.ts' },
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const revision = huddleReviewSchema.parse(read.body);
    expect(revision.active).toMatchObject({
      id: target.activationId,
      revision: saved.digest,
      worktree: f.session.worktree_path,
      variables: {},
    });
    expect(revision.saved).toBeNull();
    expect(revision.entries.every((entry) => entry.change === 'retained')).toBe(true);
    const original = readFileSync(join(f.root, 'nodes/example/run.ts'), 'utf8');
    expect(revision.content?.before).toBe(original);
    expect(revision.content?.after).toBeNull();
    const unchanged = await f.request('diff', { target, expected_digest: saved.digest });
    expect(unchanged.status).toBe(200);
    expect(
      unchanged.body.entries.every((entry: { change: string }) => entry.change === 'unchanged'),
    ).toBe(true);

    const modified = original + '\nthrow new Error("Review must never evaluate this module");\n';
    writeFileSync(join(f.root, 'nodes/example/run.ts'), modified);
    const manifest = join(f.root, 'nodes/example/node.json');
    const component = JSON.parse(readFileSync(manifest, 'utf8'));
    component.title = 'Changed contract title';
    writeFileSync(manifest, JSON.stringify(component));
    writeFileSync(join(f.root, 'layout.json'), JSON.stringify({ format: 1, nodes: {} }));
    const changed = await f.source();
    expect(
      (await f.request('diff', { target, expected_digest: saved.digest })).body.error.code,
    ).toBe('huddle_source_changed');
    const diff = await f.request('diff', {
      target,
      expected_digest: changed.digest,
      entry: { kind: 'file', path: 'nodes/example/run.ts' },
    });
    expect(diff.status, JSON.stringify(diff.body)).toBe(200);
    const comparison = huddleReviewSchema.parse(diff.body);
    expect(comparison.saved?.digest).toBe(changed.digest);
    expect(comparison.active.revision).toBe(saved.digest);
    expect(comparison.content).toMatchObject({ before: original, after: modified });
    expect(comparison.entries).toContainEqual(
      expect.objectContaining({
        entry: { kind: 'file', path: 'layout.json' },
        change: 'added',
        before: null,
      }),
    );
    const contract = comparison.entries.find(
      (item) => item.entry.kind === 'component' && item.change === 'modified',
    );
    expect(contract).toBeDefined();
    const contractDiff = await f.request('diff', {
      target,
      expected_digest: changed.digest,
      entry: contract!.entry,
    });
    expect(JSON.parse(contractDiff.body.content.after).title).toBe('Changed contract title');
    expect(JSON.parse(contractDiff.body.content.before).title).not.toBe('Changed contract title');
    expect(existsSync(join(f.home, 'entered'))).toBe(false);
    expect((await f.request('runtime')).body.owner.target).toEqual(target);
    expect(
      (await f.request('revision', { target, entry: { kind: 'file', path: 'not-captured.txt' } }))
        .body.error.code,
    ).toBe('huddle_review_entry_missing');
    expect(
      (await f.request('revision', { target, entry: { kind: 'file', path: '../escape' } })).status,
    ).toBe(400);
    const applied = await f.request('apply', {
      target,
      expected_digest: changed.digest,
      variables: {},
    });
    expect(applied.status).toBe(200);
    expect((await f.request('revision', { target })).body.error.code).toBe(
      'huddle_control_changed',
    );
    expect(
      (await f.request('revision', { target: applied.body.owner.target })).body.active.revision,
    ).toBe(changed.digest);
    expect(existsSync(join(f.home, 'entered'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps retained source inspectable after source deletion and refuses wrong profile/remote authority', async () => {
  const f = await fixture();
  try {
    const saved = await f.source();
    const started = await f.request('start', { expected_digest: saved.digest, variables: {} });
    const target = started.body.owner.target;
    const other = f.profiles.create({ name: 'other-review', branch_prefix: '' });
    expect((await f.request('revision', { target }, other.id)).body.error.code).toBe(
      'profile_scope',
    );
    rmSync(f.root, { recursive: true });
    const files = readdirSync(join(f.home, 'runtimes', target.runtimeId, 'huddle-revisions'));
    const retained = await f.request('revision', {
      target,
      entry: { kind: 'file', path: 'huddle.json' },
    });
    expect(retained.status, JSON.stringify(retained.body)).toBe(200);
    expect(JSON.parse(retained.body.content.before).id).toBe(f.session.huddle_id);
    expect(existsSync(f.root)).toBe(false);
    expect((await f.request('diff', { target, expected_digest: saved.digest })).status).not.toBe(
      200,
    );
    expect(readdirSync(join(f.home, 'runtimes', target.runtimeId, 'huddle-revisions'))).toEqual(
      files,
    );
    f.remote();
    expect((await f.request('revision', { target })).status).toBe(403);
  } finally {
    await f.close();
  }
});

it('rechecks lifecycle and authority after asynchronous source capture', async () => {
  const f = await fixture();
  try {
    const saved = await f.source();
    const started = await f.request('start', { expected_digest: saved.digest, variables: {} });
    const target = started.body.owner.target;
    const original = f.definitions.withSnapshot.bind(f.definitions);
    const spy = vi.spyOn(f.definitions, 'withSnapshot').mockImplementation(async (...args) => {
      await f.request('interrupt', { target });
      return original(...args);
    });
    const result = await f.request('diff', { target, expected_digest: saved.digest });
    expect(result.body.error.code).toBe('huddle_control_changed');
    spy.mockRestore();
    const current = (await f.request('runtime')).body.owner.target;
    vi.spyOn(f.definitions, 'withSnapshot').mockImplementation(async (...args) => {
      f.revoke();
      return original(...args);
    });
    expect(
      (await f.request('diff', { target: current, expected_digest: saved.digest })).status,
    ).toBe(401);
  } finally {
    await f.close();
  }
});

it('bounds concurrent source review and keeps queued work free of captured bundles', async () => {
  const f = await fixture();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const saved = await f.source();
    const started = await f.request('start', { expected_digest: saved.digest, variables: {} });
    const original = f.definitions.withSnapshot.bind(f.definitions);
    let concurrent = 0,
      peak = 0;
    vi.spyOn(f.definitions, 'withSnapshot').mockImplementation(async (...args) => {
      peak = Math.max(peak, ++concurrent);
      try {
        await hold;
        return await original(...args);
      } finally {
        concurrent--;
      }
    });
    const pending = Array.from({ length: 9 }, () =>
      f.request('diff', { target: started.body.owner.target, expected_digest: saved.digest }),
    );
    expect((await Promise.race(pending)).body.error.code).toBe('huddle_review_busy');
    release();
    const results = await Promise.all(pending);
    expect(results.filter((result) => result.status === 200)).toHaveLength(8);
    expect(peak).toBe(1);
  } finally {
    release();
    await f.close();
  }
});
