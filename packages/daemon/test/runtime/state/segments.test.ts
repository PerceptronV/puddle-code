import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_LIMITS, type RuntimeTerminal } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { LogStore } from '../../../src/logs/log-store.js';
import { RuntimeSegments } from '../../../src/runtime/state/segments.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(options?: ConstructorParameters<typeof RuntimeSegments>[4]) {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-runtime-segments-'));
  const identity = {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    profile_id: '1111111111',
    project_id: '2222222222',
    session_id: randomUUID(),
    canonical_worktree_path: directory,
  };
  const logs = new LogStore(join(directory, 'logs'), 1024);
  const history = new RuntimeSegments(directory, identity, logs, null, options);
  const terminal: RuntimeTerminal = {
    term: 'agent',
    generation: randomUUID(),
    pid: 1234,
    exit_code: null,
    cols: 80,
    rows: 24,
  };
  cleanups.push(async () => {
    await history.drain();
    logs.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  const lifecycle = (ref: string, cursor: number, capture = async () => 'boundary-screen') =>
    history.lifecycle(
      { event: 'session_start', agent_session_ref: ref, cwd: directory, source: 'clear' },
      cursor,
      [terminal],
      capture,
    );
  return { directory, identity, logs, history, terminal, lifecycle };
}

describe('runtime history segments', () => {
  it('rejects a checkpoint whose private record belongs to another owner', async () => {
    const f = fixture();
    const first = f.lifecycle('one', 1);
    f.lifecycle('two', 2);
    await f.history.drain();
    const record = await f.history.read(first.segment.id, 'agent', f.terminal.generation);
    atomicPrivateJson(
      join(f.directory, 'segments', `${first.segment.id}.agent.${f.terminal.generation}.json`),
      {
        ...record,
        identity: { ...record.identity, incarnation: randomUUID() },
      },
    );
    await expect(f.history.read(first.segment.id, 'agent', f.terminal.generation)).rejects.toThrow(
      'identity changed',
    );
  });

  it('binds initial identity without rotating, then freezes exact boundaries without replaying output', async () => {
    const f = fixture();
    const capture = vi.fn(async () => 'before-switch');
    const first = f.lifecycle('native-one', 2, capture);
    expect(first.previous_segment_id).toBeNull();
    expect(first.segment.id).toBe(f.identity.runtime_id);
    expect(f.lifecycle('native-one', 3, capture).segment).toEqual(first.segment);
    expect(capture).not.toHaveBeenCalled();
    f.history.append(f.terminal, 'old-output');
    const next = f.lifecycle('native-two', 5, capture);
    expect(capture).toHaveBeenCalledTimes(1);
    f.history.append(f.terminal, 'new-output');
    await f.history.drain();
    const record = await f.history.read(first.segment.id, 'agent', f.terminal.generation);
    expect(record).toMatchObject({
      identity: f.identity,
      segment: first.segment,
      through: 4,
      data: 'before-switch',
      terminal: f.terminal,
    });
    expect(next.previous_segment_id).toBe(first.segment.id);
    expect(next.segment.start_cursor).toBe(5);
    const term = `agent.${f.terminal.generation}`;
    expect(f.logs.readTail(first.segment.id, term)).toBe('old-output');
    expect(f.logs.readTail(next.segment.id, term)).toBe('new-output');
    expect(
      statSync(join(f.directory, 'segments', `${first.segment.id}.${term}.json`)).mode & 0o777,
    ).toBe(0o600);
    await expect(f.history.read('../escape', 'agent', f.terminal.generation)).rejects.toThrow();
    await expect(f.history.read(first.segment.id, 'agent', randomUUID())).rejects.toThrow();
  });

  it('bounds stalled captures and reports gaps without delaying segment changes', async () => {
    let release!: (data: string) => void;
    const capture = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const f = fixture({ pendingCount: 1 });
    f.lifecycle('one', 1);
    const second = f.lifecycle('two', 2, capture);
    const third = f.lifecycle('three', 3, capture);
    expect(third.segment.id).not.toBe(second.segment.id);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(f.history.state()).toMatchObject({ pending_checkpoints: 1, gap: true });
    release('first-boundary');
    await f.history.drain();
    expect(f.history.state().pending_checkpoints).toBe(0);
  });

  it('reports snapshot write failure and byte limits while continuing to record exact segment identities', async () => {
    for (const options of [
      {
        write: vi.fn(async () => {
          throw new Error('disk full');
        }),
      },
      { snapshotBytes: 32 },
      { pendingBytes: 32 },
      { maxSegments: 1 },
    ]) {
      const f = fixture(options);
      f.lifecycle('one', 1);
      const second = f.lifecycle('two', 2);
      await f.history.drain();
      expect(f.history.state()).toMatchObject({
        current: second.segment,
        pending_checkpoints: 0,
        gap: true,
      });
    }
  });

  it('bounds raw history independently of snapshots and never appends dropped bytes to another segment', async () => {
    const f = fixture({ logBytes: 4 });
    const first = f.lifecycle('one', 1);
    f.history.append(f.terminal, 'four');
    const next = f.lifecycle('two', 2);
    f.history.append(f.terminal, 'dropped');
    await f.history.drain();
    expect(f.history.state().gap).toBe(true);
    expect(f.logs.readTail(first.segment.id, `agent.${f.terminal.generation}`)).toBe('four');
    expect(f.logs.readTail(next.segment.id, `agent.${f.terminal.generation}`)).toBe('');
    expect((await f.history.read(first.segment.id, 'agent', f.terminal.generation)).data).toBe(
      'boundary-screen',
    );
  });
});

describe('runtime raw log stream limits', () => {
  it('bounds generation churn without stopping admitted streams or boundary checkpoints', async () => {
    const f = fixture({ logFiles: 2, logBytes: 12 });
    const first = f.lifecycle('one', 1);
    f.history.append(f.terminal, 'first');
    const second = { ...f.terminal, generation: randomUUID() };
    f.history.append(second, 'next');
    for (let index = 0; index < 50; index++) {
      f.history.append({ ...f.terminal, generation: randomUUID() }, 'refused-output');
    }
    // Rejected new streams do not consume the remaining raw-byte allowance.
    f.history.append(f.terminal, '+ok');
    expect(f.logs.readTail(first.segment.id, `agent.${f.terminal.generation}`)).toBe('first+ok');
    expect(f.logs.readTail(first.segment.id, `agent.${second.generation}`)).toBe('next');
    expect(readdirSync(join(f.directory, 'logs', first.segment.id))).toHaveLength(2);
    const next = f.lifecycle('two', 2);
    expect(next.previous_segment_id).toBe(first.segment.id);
    await f.history.drain();
    expect((await f.history.read(first.segment.id, 'agent', f.terminal.generation)).data).toBe(
      'boundary-screen',
    );
    expect(f.history.state()).toMatchObject({
      current: next.segment,
      gap: true,
      pending_checkpoints: 0,
    });
  });

  it('counts exact segment, terminal and generation identities and ignores empty output', async () => {
    const f = fixture({ logFiles: 3 });
    const first = f.lifecycle('one', 1);
    for (let index = 0; index < 10; index++)
      f.history.append({ ...f.terminal, generation: randomUUID() }, '');
    f.history.append(f.terminal, 'agent');
    f.history.append({ ...f.terminal, term: 'shell-1' }, 'shell');
    const next = f.lifecycle('two', 2);
    f.history.append(f.terminal, 'next');
    const refused = { ...f.terminal, generation: randomUUID() };
    f.history.append(refused, 'refused');
    f.history.append(f.terminal, '-continued');
    expect(f.logs.readTail(first.segment.id, `agent.${f.terminal.generation}`)).toBe('agent');
    expect(f.logs.readTail(first.segment.id, `shell-1.${f.terminal.generation}`)).toBe('shell');
    expect(f.logs.readTail(next.segment.id, `agent.${f.terminal.generation}`)).toBe(
      'next-continued',
    );
    expect(f.logs.readTail(next.segment.id, `agent.${refused.generation}`)).toBe('');
    expect(readdirSync(join(f.directory, 'logs', first.segment.id))).toHaveLength(2);
    expect(readdirSync(join(f.directory, 'logs', next.segment.id))).toHaveLength(1);
    expect(f.history.state().gap).toBe(true);
  });

  it.each([undefined, RUNTIME_LIMITS.historyLogFiles + 1])(
    'enforces the production ceiling even with an excessive fixture limit (%s)',
    (logFiles) => {
      const f = fixture({ logFiles });
      const append = vi.spyOn(f.logs, 'append').mockImplementation(() => {});
      for (let index = 0; index < RUNTIME_LIMITS.historyLogFiles + 1; index++) {
        f.history.append({ ...f.terminal, generation: randomUUID() }, 'x');
      }
      expect(append).toHaveBeenCalledTimes(RUNTIME_LIMITS.historyLogFiles);
      expect(f.history.state().gap).toBe(true);
    },
  );
});

it('bounds occupied checkpoint slots across native switches while raw output and exact lifecycle identities continue', async () => {
  const f = fixture();
  const first = f.lifecycle('first', 1);
  f.lifecycle('second', 2);
  await f.history.drain();
  const checkpoint = await f.history.read(first.segment.id, 'agent', f.terminal.generation);
  const directory = join(f.directory, 'segments');
  for (let slot = 0; slot < RUNTIME_LIMITS.pendingCheckpoints; slot++)
    writeFileSync(join(directory, `.checkpoint-${slot}.tmp`), 'uncertain', {
      mode: 0o600,
      flag: 'wx',
    });
  for (let index = 0; index < RUNTIME_LIMITS.pendingCheckpoints + 5; index++) {
    f.lifecycle(`later-${index}`, index + 3);
    await f.history.drain();
    f.history.append(f.terminal, `output-${index}`);
  }
  const current = f.history.state();
  expect(current).toMatchObject({
    gap: true,
    pending_checkpoints: 0,
    current: { agent_session_ref: `later-${RUNTIME_LIMITS.pendingCheckpoints + 4}` },
  });
  expect(f.logs.readTail(current.current.id, `agent.${f.terminal.generation}`)).toBe(
    `output-${RUNTIME_LIMITS.pendingCheckpoints + 4}`,
  );
  expect(await f.history.read(first.segment.id, 'agent', f.terminal.generation)).toEqual(
    checkpoint,
  );
  expect(readdirSync(directory)).toHaveLength(RUNTIME_LIMITS.pendingCheckpoints + 1);
});
