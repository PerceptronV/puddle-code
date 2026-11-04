import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import {
  relayMessageSchema,
  type RemoteMessage,
  type HostMaintenanceCommand,
  hostMaintenanceReplySchema,
} from '@puddle/shared';
import {
  secureChannel,
  SocketWire,
  type EncryptedChannel,
} from '../../../../../remote-transport/src/index.js';

/** Actual WSS/Noise client, explicit participation and no reconnection or mutation replay. */
export async function continuityBrowser(options: {
  service: string;
  app: string;
  certPath: string;
  cookie: string;
  host: string;
  account: string;
  hostPeer: string;
  identity: Uint8Array;
}) {
  const socket = new WebSocket(options.service.replace('https:', 'wss:') + '/remote/browser', {
    ca: readFileSync(options.certPath),
    headers: { origin: options.app, cookie: options.cookie },
  });
  let wire: SocketWire | undefined;
  let channel: EncryptedChannel | undefined;
  let failure: unknown;
  let closed = false;
  const received: RemoteMessage[] = [];
  const requests: Array<Extract<RemoteMessage, { t: 'request' }>> = [];
  const pending = new Set<string>();
  const dropped = new Set<string>();
  socket.on('error', (error) => {
    failure = error;
  });
  socket.on('close', () => {
    closed = true;
    wire?.onTransportClosed();
  });
  socket.on('message', (data, binary) => {
    if (wire) {
      if (!binary) return socket.terminate();
      wire.receive(Buffer.from(data as Buffer));
      return;
    }
    const ready = relayMessageSchema.parse(JSON.parse(String(data)));
    if (ready.t !== 'ready' || ready.account !== options.account) return socket.terminate();
    wire = new SocketWire(socket, 'outbound');
    void secureChannel(
      wire,
      options.identity,
      {
        service: options.service,
        host: options.host,
        hostPeer: options.hostPeer,
        connection: ready.connection,
      },
      'outbound',
    )
      .then(async (current) => {
        channel = current;
        await current.send({ t: 'hello', account: options.account, label: 'Continuity browser' });
        for await (const message of current.messages()) {
          if (message.t === 'challenge')
            await current.send({
              t: 'participate',
              nonce: message.nonce,
              generation: message.generation,
              resources: [...pending],
            });
          if ('id' in message && dropped.has(message.id)) continue;
          received.push(message);
        }
      })
      .catch((error: unknown) => {
        if (!closed) failure = error;
      });
  });
  const wait = async <T>(
    read: () => T | undefined,
    description: string,
    timeout = 120_000,
  ): Promise<T> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (failure) throw new Error(description, { cause: failure });
      if (closed) throw new Error(`${description}: encrypted transport closed`);
      if (Date.now() > deadline) throw new Error(`${description}: timed out`);
      await delay(20);
    }
  };
  await once(socket, 'open');
  socket.send(JSON.stringify({ t: 'connect', host: options.host }));
  const admitted = await wait(
    () => received.find((message) => message.t === 'admitted'),
    'Noise admission',
    15_000,
  );
  const sendRequest = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    dropReply = false,
  ) => {
    const request = {
      t: 'request',
      id: randomUUID(),
      method,
      path,
      ...(body === undefined ? {} : { body }),
    } as const;
    requests.push(request);
    pending.add(request.id);
    if (dropReply) dropped.add(request.id);
    await channel!.send(request);
    return request.id;
  };
  const request = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const id = await sendRequest(method, path, body);
    try {
      return await wait(
        () =>
          received.find(
            (message): message is Extract<RemoteMessage, { t: 'response' }> =>
              message.t === 'response' && message.id === id,
          ),
        'Encrypted request',
      );
    } finally {
      pending.delete(id);
    }
  };
  return {
    admitted,
    received,
    requests,
    request,
    async maintenance(command: HostMaintenanceCommand) {
      const reply =
        command.action === 'status'
          ? await request('GET', '/api/host/updates' + (command.id ? `?id=${command.id}` : ''))
          : await request('POST', '/api/host/updates', command);
      if (reply.status !== 200)
        throw new Error(`Maintenance rejected: ${JSON.stringify(reply.body)}`);
      return hostMaintenanceReplySchema.parse(
        command.action === 'status'
          ? { kind: 'status', status: reply.body }
          : { kind: 'result', result: reply.body },
      );
    },
    dropApplyReply: (command: HostMaintenanceCommand) =>
      sendRequest('POST', '/api/host/updates', command, true),
    async terminal(message: Extract<RemoteMessage, { t: 'terminal' }>['message']) {
      const id = randomUUID();
      pending.add(id);
      try {
        await channel!.send({ t: 'terminal', id, message });
        await wait(
          () => received.find((entry) => entry.t === 'sent' && entry.id === id),
          'Terminal acknowledgement',
        );
      } finally {
        pending.delete(id);
      }
    },
    async stream() {
      const id = randomUUID();
      pending.add(id);
      await channel!.send({ t: 'stream', id });
      await wait(
        () =>
          received.find(
            (message) => message.t === 'event' && message.message.t === 'authenticated',
          ),
        'Remote event stream',
      );
    },
    text: () =>
      received
        .flatMap((message) =>
          message.t === 'event' &&
          (message.message.t === 'output' || message.message.t === 'replay')
            ? [message.message.data]
            : [],
        )
        .join(''),
    close() {
      closed = true;
      channel?.close();
      socket.terminate();
    },
  };
}
