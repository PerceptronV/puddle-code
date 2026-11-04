import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_LIMITS, type RuntimeTerminal } from '@puddle/shared';
import { LogStore } from '../../../src/logs/log-store.js';
import { TerminalScreenStateStore } from '../../../src/pty/terminal-screen-state.js';
import { SCREEN_LIMITS } from '../../../src/pty/screen/limits.js';
import {
  RuntimeSegments,
  type RuntimeCheckpointCapture,
} from '../../../src/runtime/state/segments.js';
import { CHECKPOINT_METADATA_BYTES } from '../../../src/runtime/state/checkpoints/capacity.js';
import { ScreenAllowance } from '../../helpers/pty/allowance.js';

const readerFault = vi.hoisted(() => ({ grow: '' }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (args[0] === readerFault.grow) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const value = await stat();
          appendFileSync(readerFault.grow, 'changed after stat');
          return value;
        }) as typeof handle.stat;
      }
      return handle;
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  readerFault.grow = '';
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(options: ConstructorParameters<typeof RuntimeSegments>[4] = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-checkpoint-capacity-'));
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
  const allowance = new ScreenAllowance(128 * 1024 * 1024);
  const history = new RuntimeSegments(directory, identity, logs, 'original', {
    allowance,
    ...options,
  });
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
  return { directory, identity, history, terminal, allowance };
}

describe('checkpoint memory ownership', () => {
  it('admits escaped and Unicode screen data using the shared exact JSON measurement', async () => {
    const values = ['plain', '\u0000\u0001\b\t\n\f\r"\\', 'é中😀', '\ud800x\udc00'];
    for (let start = 0; start < 65536; start += 257)
      values.push(String.fromCharCode(...Array.from({ length: 257 }, (_, index) => start + index)));
    const data = values.join('');
    const f = fixture();
    f.history.seal(1, [f.terminal], async (_term, accept) => {
      accept(data);
      return data;
    });
    await f.history.drain();
    expect(f.history.state().gap).toBe(false);
    expect((await f.history.read(f.identity.runtime_id, 'agent', f.terminal.generation)).data).toBe(
      data,
    );
    expect(f.allowance.used).toBe(0);
  });

  it('reserves before capture and holds measured strings through stalled file IO', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = vi.fn(async () => blocked);
    const f = fixture({ write });
    let transfer!: (data: string) => void;
    let captured!: (data: string) => void;
    const capture: RuntimeCheckpointCapture = (_term, accept) => {
      expect(f.allowance.used).toBe(CHECKPOINT_METADATA_BYTES);
      transfer = accept;
      return new Promise((resolve) => {
        captured = resolve;
      });
    };
    f.history.seal(2, [f.terminal], capture);
    expect(f.allowance.used).toBe(CHECKPOINT_METADATA_BYTES);
    const data = 'line\r\n中😀'.repeat(100);
    transfer(data);
    const retained = f.allowance.used;
    expect(retained).toBeGreaterThan(CHECKPOINT_METADATA_BYTES + 2 * data.length);
    captured(data);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(f.allowance.used).toBe(retained);
    finish();
    await f.history.drain();
    expect(f.allowance.used).toBe(0);
    expect(f.history.state().gap).toBe(false);
    expect(() => transfer('late')).toThrow('hand-off');
    expect(f.allowance.used).toBe(0);
  });

  it('refuses before capture and returns metadata after synchronous and asynchronous faults', async () => {
    const f = fixture();
    const capture = vi.fn(async () => 'not dispatched');
    f.allowance.capacity = CHECKPOINT_METADATA_BYTES - 1;
    expect(() => f.history.seal(1, [f.terminal], capture)).not.toThrow();
    expect(capture).not.toHaveBeenCalled();
    expect(f.history.state().gap).toBe(true);
    expect(f.allowance.used).toBe(0);
    f.allowance.capacity *= 2;
    expect(() =>
      f.history.seal(2, [f.terminal], () => {
        throw new Error('capture failed');
      }),
    ).not.toThrow();
    f.history.seal(3, [f.terminal], async () => {
      throw new Error('queued capture failed');
    });
    await f.history.drain();
    expect(f.allowance.used).toBe(0);
  });

  it('does not write without exact hand-off or after enclosing/local admission failure', async () => {
    for (const kind of ['missing', 'changed', 'host', 'local', 'write'] as const) {
      const write = vi.fn(async () => {
        if (kind === 'write') throw new Error('disk failed');
      });
      const f = fixture({
        write,
        ...(kind === 'local' ? { pendingBytes: CHECKPOINT_METADATA_BYTES } : {}),
      });
      f.history.seal(1, [f.terminal], async (_term, accept) => {
        if (kind === 'missing') return 'missing';
        if (kind === 'host') f.allowance.capacity = CHECKPOINT_METADATA_BYTES;
        accept('original');
        return kind === 'changed' ? 'different' : 'original';
      });
      await f.history.drain();
      expect(write).toHaveBeenCalledTimes(kind === 'write' ? 1 : 0);
      expect(f.history.state()).toMatchObject({ gap: true, pending_checkpoints: 0 });
      expect(f.allowance.used).toBe(0);
    }
  });

  it('transfers real screen snapshots before work release for many small shells at one boundary', async () => {
    const f = fixture();
    const screens = new TerminalScreenStateStore(undefined, undefined, { allowance: f.allowance });
    cleanups.push(() => screens.closeAll());
    const terminals = Array.from({ length: 12 }, (_, index) => ({
      ...f.terminal,
      term: `shell-${index + 1}`,
      generation: randomUUID(),
    }));
    for (const term of terminals)
      screens.write(f.identity.runtime_id, term.term, `before-${term.term}`);
    let handoffs = 0;
    f.history.seal(
      10,
      terminals,
      async (term, accept) =>
        (await screens.snapshot(f.identity.runtime_id, term.term, (data) => {
          expect(f.allowance.used).toBeGreaterThan(SCREEN_LIMITS.operationBytes);
          accept(data);
          handoffs++;
        })) ?? '',
    );
    for (const term of terminals)
      screens.write(f.identity.runtime_id, term.term, '-after-boundary');
    await f.history.drain();
    expect(handoffs).toBe(12);
    expect(f.history.state().gap).toBe(false);
    for (const term of terminals) {
      const checkpoint = await f.history.read(f.identity.runtime_id, term.term, term.generation);
      expect(checkpoint.through).toBe(10);
      expect(checkpoint.data).toContain(`before-${term.term}`);
      expect(checkpoint.data).not.toContain('-after-boundary');
    }
    await screens.closeAll();
    expect(f.allowance.used).toBe(0);
  });

  it('refused transfer leaves the actual canonical screen available for later output', async () => {
    const f = fixture({ pendingBytes: CHECKPOINT_METADATA_BYTES });
    const screens = new TerminalScreenStateStore(undefined, undefined, { allowance: f.allowance });
    cleanups.push(() => screens.closeAll());
    screens.write('screen', 'agent', 'before');
    f.history.seal(
      1,
      [f.terminal],
      async (_term, accept) => (await screens.snapshot('screen', 'agent', accept)) ?? '',
    );
    await f.history.drain();
    expect(f.history.state().gap).toBe(true);
    expect(() => screens.write('screen', 'agent', '-after')).not.toThrow();
    expect(await screens.snapshot('screen', 'agent')).toContain('before-after');
    await screens.closeAll();
    expect(f.allowance.used).toBe(0);
  });

  it('rejects oversized immutable checkpoint files before reading their contents', async () => {
    const f = fixture();
    const file = join(
      f.directory,
      'segments',
      `${f.identity.runtime_id}.agent.${f.terminal.generation}.json`,
    );
    writeFileSync(file, '', { mode: 0o600 });
    truncateSync(file, RUNTIME_LIMITS.frameBytes);
    await expect(
      f.history.read(f.identity.runtime_id, 'agent', f.terminal.generation),
    ).rejects.toThrow('byte limit');
  });

  it('rejects checkpoint growth after the initial stat with a bounded read', async () => {
    const f = fixture();
    f.history.seal(1, [f.terminal], async (_term, accept) => {
      accept('bounded');
      return 'bounded';
    });
    await f.history.drain();
    readerFault.grow = join(
      f.directory,
      'segments',
      `${f.identity.runtime_id}.agent.${f.terminal.generation}.json`,
    );
    await expect(
      f.history.read(f.identity.runtime_id, 'agent', f.terminal.generation),
    ).rejects.toThrow('changed while being read');
  });
});
