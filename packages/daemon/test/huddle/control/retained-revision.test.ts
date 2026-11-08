import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { huddleRetainedRevisionSchema } from '@puddle/shared';
import { huddleExecutionFixture as fixture } from '../../helpers/huddle/execution.js';

it('inspects old and last recorded revisions after Stop, compares exact saved source and survives deletion', async () => {
  const f = await fixture();
  try {
    const first = await f.source();
    const started = await f.request('start', { expected_digest: first.digest, variables: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const target = started.body.owner.target;
    const owner = { runtimeId: target.runtimeId, incarnation: target.incarnation };
    const path = 'nodes/example/run.ts';
    const before = readFileSync(join(f.root, path), 'utf8');
    const after = before + '\nthrow new Error("Inspection must not evaluate code");\n';
    writeFileSync(join(f.root, path), after);
    const second = await f.source();
    const applied = await f.request('apply', {
      target,
      expected_digest: second.digest,
      variables: {},
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const current = (await f.request('runtime')).body.owner.target;
    expect((await f.request('stop', { target: current })).status).toBe(200);
    const directory = join(f.home, 'runtimes', owner.runtimeId);
    const names = readdirSync(directory);
    const bytes = readFileSync(join(directory, 'huddle.sqlite'));
    const inspect = vi.spyOn(f.controls.huddles, 'inspect');
    const request = { owner, entry: { kind: 'file', path } };
    const last = await f.request('revision/retained', request);
    expect(last.status, JSON.stringify(last.body)).toBe(200);
    const recorded = huddleRetainedRevisionSchema.parse(last.body);
    expect(recorded.activation).toMatchObject({
      id: current.activationId,
      revision: second.digest,
      worktree: f.session.worktree_path,
    });
    expect(recorded.content?.before).toBe(after);
    expect(recorded).not.toHaveProperty('target');
    const historical = await f.request('revision/retained', { ...request, revision: first.digest });
    expect(historical.status).toBe(200);
    expect(historical.body.activation).toBeNull();
    expect(historical.body.content.before).toBe(before);
    const comparison = await f.request('revision/retained', {
      ...request,
      revision: first.digest,
      expected_digest: second.digest,
    });
    expect(comparison.status, JSON.stringify(comparison.body)).toBe(200);
    expect(comparison.body.content).toMatchObject({ before, after });
    expect(
      (await f.request('revision/retained', { ...request, expected_digest: first.digest })).body
        .error.code,
    ).toBe('huddle_source_changed');
    rmSync(f.root, { recursive: true });
    expect((await f.request('revision/retained', request)).status).toBe(200);
    expect(
      (await f.request('revision/retained', { ...request, revision: first.digest })).status,
    ).toBe(200);
    expect(existsSync(f.root)).toBe(false);
    expect(readFileSync(join(directory, 'huddle.sqlite'))).toEqual(bytes);
    expect(readdirSync(directory)).toEqual(names);
    expect(inspect).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.request('revision/retained', {
          ...request,
          owner: { ...owner, incarnation: randomUUID() },
        })
      ).status,
    ).toBe(409);
    expect(
      (await f.request('revision/retained', { ...request, revision: 'b'.repeat(64) })).status,
    ).toBe(409);
    expect(
      (
        await f.request('revision/retained', {
          ...request,
          entry: { kind: 'file', path: '../secret' },
        })
      ).status,
    ).toBe(400);
    writeFileSync(join(directory, 'huddle-revisions', `${second.digest}.json`), '{}');
    const corrupt = await f.request('revision/retained', request);
    expect(corrupt.status).toBe(409);
    expect(JSON.stringify(corrupt.body)).not.toContain(f.home);
    f.remote();
    expect((await f.request('revision/retained', request)).status).toBe(403);
  } finally {
    await f.close();
  }
});

it('rechecks authority and retained binding after asynchronous saved capture', async () => {
  const f = await fixture();
  try {
    const saved = await f.source();
    const start = await f.request('start', { expected_digest: saved.digest, variables: {} });
    const target = start.body.owner.target;
    expect((await f.request('stop', { target })).status).toBe(200);
    const input = {
      owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
      expected_digest: saved.digest,
    };
    const original = f.definitions.withSnapshot.bind(f.definitions);
    const spy = vi.spyOn(f.definitions, 'withSnapshot').mockImplementation(async (...args) => {
      f.db
        .prepare('UPDATE runtime_bindings SET incarnation = ? WHERE runtime_id = ?')
        .run(randomUUID(), target.runtimeId);
      return original(...args);
    });
    expect((await f.request('revision/retained', input)).status).toBe(409);
    spy.mockRestore();
    f.db
      .prepare('UPDATE runtime_bindings SET incarnation = ? WHERE runtime_id = ?')
      .run(target.incarnation, target.runtimeId);
    vi.spyOn(f.definitions, 'withSnapshot').mockImplementation(async (...args) => {
      f.revoke();
      return original(...args);
    });
    expect((await f.request('revision/retained', input)).status).toBe(401);
  } finally {
    await f.close();
  }
});
