import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeTerminal } from '@puddle/shared';
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
