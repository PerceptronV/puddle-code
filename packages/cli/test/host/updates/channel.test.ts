import { Duplex, PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostUpdateCommand } from '@puddle/shared';
import {
  requestParticipatingUpdate,
  serveParticipatingUpdate,
} from '../../../src/lib/host/updates/channel.js';
import { continueStoredHostUpdate } from '../../../src/lib/host/updates/continuation.js';

vi.mock('../../../src/lib/host/updates/continuation.js', () => ({
  continueStoredHostUpdate: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const command: HostUpdateCommand = {
  action: 'recover',
  strategy: 'continue',
  reference: { id: randomUUID(), revision: 1 },
};

it.each(['close', 'duplicate', 'malformed'] as const)(
  'revokes pending helper work on %s without replay',
  async (cause) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = Duplex.from({ readable: output, writable: input });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let participation!: NonNullable<Parameters<typeof continueStoredHostUpdate>[2]>;
    vi.mocked(continueStoredHostUpdate).mockImplementationOnce(async (_home, _command, options) => {
      participation = options!;
      entered();
      await held;
      return { ok: true, operation: null };
    });
    const helper = serveParticipatingUpdate('/unused-fixture-home', input, output);
    const controller = new AbortController();
    const pending = expect(
      requestParticipatingUpdate(channel, command, controller.signal, () => true),
    ).rejects.toThrow();
    await started;
    try {
      if (cause === 'close') controller.abort();
      else if (cause === 'duplicate')
        input.write(JSON.stringify({ t: 'host-update', request_id: randomUUID(), command }) + '\n');
      else input.write('not JSON\n');
      await vi.waitFor(() => expect(participation.signal.aborted).toBe(true));
      expect(participation.authorised()).toBe(false);
    } finally {
      release();
      await helper;
      output.end();
    }
    await pending;
    expect(continueStoredHostUpdate).toHaveBeenCalledOnce();
  },
);

it.each(['{}\n', 'x'.repeat(16 * 1024 + 1)])(
  'rejects malformed or excessive input before invoking a dispatcher',
  async (value) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const helper = serveParticipatingUpdate('/unused-fixture-home', input, output);
    input.write(value);
    await helper;
    output.destroy();
    expect(continueStoredHostUpdate).not.toHaveBeenCalled();
  },
);
