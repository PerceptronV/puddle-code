import { describe, expect, it } from 'vitest';
import { createIdentity, identityPeer, secureChannel, SocketWire } from '../src/index.js';

async function pair(wrongHost = false, wrongContext = false) {
  const host = await createIdentity();
  const browser = await createIdentity();
  const captured: Uint8Array[] = [];
  let tamper = false;
  const a = new SocketWire(
    {
      bufferedAmount: 0,
      close: () => b.onTransportClosed(),
      send(data) {
        const copy = data.slice();
        captured.push(copy.slice());
        if (tamper) copy[copy.length - 1]! ^= 1;
        queueMicrotask(() => b.receive(copy));
      },
    },
    'outbound',
  );
  const b = new SocketWire(
    {
      bufferedAmount: 0,
      close: () => a.onTransportClosed(),
      send(data) {
        captured.push(data.slice());
        queueMicrotask(() => a.receive(data));
      },
    },
    'inbound',
  );
  const context = {
    service: 'https://relay.example.test',
    host: crypto.randomUUID(),
    hostPeer: identityPeer(wrongHost ? await createIdentity() : host),
    connection: crypto.randomUUID(),
  };
  const channels = await Promise.allSettled([
    secureChannel(a, browser, context, 'outbound'),
    secureChannel(
      b,
      host,
      wrongContext ? { ...context, connection: crypto.randomUUID() } : context,
      'inbound',
    ),
  ]);
  return {
    channels,
    captured,
    a,
    b,
    corrupt: () => {
      tamper = true;
    },
    browser: identityPeer(browser),
  };
}

describe('encrypted remote transport', () => {
  it('pins the host, proves the browser identity and carries ordered Unicode messages without plaintext on the wire', async () => {
    const fixture = await pair();
    const [a, b] = fixture.channels;
    if (a?.status !== 'fulfilled' || b?.status !== 'fulfilled') throw new Error('Handshake failed');
    expect(b.value.peer).toBe(fixture.browser);
    const incoming = b.value.messages();
    const next = incoming.next();
    const label = 'Phone — 日本語';
    await a.value.send({ t: 'hello', account: 'owner', label });
    expect((await next).value).toEqual({ t: 'hello', account: 'owner', label });
    expect(fixture.captured.some((bytes) => new TextDecoder().decode(bytes).includes(label))).toBe(
      false,
    );
    a.value.close();
    b.value.close();
  });
  it('rejects a substituted host identity before application traffic', async () => {
    const fixture = await pair(true);
    expect(fixture.channels[0]?.status).toBe('rejected');
    fixture.a.abort(new Error('done'));
    fixture.b.abort(new Error('done'));
  });
  it('rejects tampering with an authenticated transport record', async () => {
    const fixture = await pair();
    const [a, b] = fixture.channels;
    if (a?.status !== 'fulfilled' || b?.status !== 'fulfilled') throw new Error('Handshake failed');
    const result = b.value.messages().next();
    const rejected = expect(result).rejects.toThrow();
    fixture.corrupt();
    await a.value.send({ t: 'hello', account: 'owner', label: 'Phone' }).catch(() => {});
    await rejected;
    a.value.close();
    b.value.close();
  });
  it('rejects an authenticated record replay within the same connection', async () => {
    const fixture = await pair();
    const [a, b] = fixture.channels;
    if (a?.status !== 'fulfilled' || b?.status !== 'fulfilled') throw new Error('Handshake failed');
    const incoming = b.value.messages();
    const first = incoming.next();
    const offset = fixture.captured.length;
    await a.value.send({ t: 'hello', account: 'owner', label: 'Phone' });
    await first;
    const rejected = expect(incoming.next()).rejects.toThrow();
    for (const frame of fixture.captured.slice(offset)) fixture.b.receive(frame);
    await rejected;
    a.value.close();
    b.value.close();
  });
  it('binds the handshake to the fresh connection context', async () => {
    const fixture = await pair(false, true);
    expect(fixture.channels.every((result) => result.status === 'rejected')).toBe(true);
    fixture.a.abort(new Error('done'));
    fixture.b.abort(new Error('done'));
  });
});
