import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Socket } from 'node:net';
import { expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  serializeHostUpdateCommand,
  type HostUpdateCommand,
} from '@puddle/shared';
import { ipcPath, jsonLines, listenPrivate } from '@puddle/shared/node';
import { env, root, stop, until } from '../helpers.js';

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-control-helper-'));
  const path = ipcPath(home, 'host');
  const sockets = new Set<Socket>();
  const received: unknown[] = [];
  const server = await listenPrivate(path, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    jsonLines(
      socket,
      (message) => {
        received.push(message);
        const request = message as { request_id: string };
        socket.write(
          JSON.stringify({
            t: 'host-update-result',
            request_id: request.request_id,
            result: { ok: false, code: 'unsupported', operation: null },
          }) + '\n',
        );
      },
      () => socket.destroy(),
    );
  });
  const child = spawn(process.execPath, [join(root, 'packages/cli/dist/host-control.mjs')], {
    env: env(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies: unknown[] = [];
  jsonLines(
    child.stdout,
    (message) => replies.push(message),
    () => {},
  );
  child.stderr.resume();
  child.stdin.on('error', () => {});
  return {
    child,
    received,
    replies,
    async close() {
      await stop(child);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dirname(path), { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

it('preserves the published update wire fields through the built SSH helper', async () => {
  const f = await fixture();
  try {
    const reference = { id: randomUUID(), revision: 3 };
    const commands: HostUpdateCommand[] = [
      { action: 'inspect', reference, frontend: PROTOCOL_VERSION },
      {
        action: 'apply',
        reference,
        frontend: PROTOCOL_VERSION,
        fingerprint: 'a'.repeat(64),
        interruption_approval: 'b'.repeat(64),
      },
      { action: 'status', id: reference.id, include_recovery: true },
    ];
    for (const command of commands) {
      const request = {
        t: 'host-update',
        request_id: randomUUID(),
        command: serializeHostUpdateCommand(command),
      };
      const count = f.received.length;
      f.child.stdin.write(JSON.stringify(request) + '\n');
      await until(
        () => f.replies.length,
        (length) => length === count + 1,
        5000,
      );
      // Released 25.x/26.x daemons require `cockpit` and reject `frontend`.
      // Check the actual helper output, beyond the client's own serializer.
      expect(f.received[count]).toEqual(request);
      expect(f.replies[count]).toEqual({
        t: 'host-update-result',
        request_id: request.request_id,
        result: { ok: false, code: 'unsupported', operation: null },
      });
    }
    expect(f.child.exitCode).toBeNull();
  } finally {
    await f.close();
  }
});

it('still rejects ambiguous protocol fields before forwarding a mutation', async () => {
  const f = await fixture();
  try {
    f.child.stdin.write(
      JSON.stringify({
        t: 'host-update',
        request_id: randomUUID(),
        command: {
          action: 'apply',
          reference: { id: randomUUID(), revision: 1 },
          frontend: PROTOCOL_VERSION,
          cockpit: { major: 26, minor: 22 },
          fingerprint: 'a'.repeat(64),
        },
      }) + '\n',
    );
    await until(
      () => f.child.exitCode,
      (code) => code !== null,
      5000,
    );
    expect(f.received).toEqual([]);
    expect(f.replies).toEqual([]);
  } finally {
    await f.close();
  }
});
