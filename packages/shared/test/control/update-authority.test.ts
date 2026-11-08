import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  type ControlRequest,
  type VersionResponse,
  type HostUpdateReply,
} from '../../src/index.js';
import { HostControlClient } from '../../src/node/host-control.js';
import { HostUpdateOnlyScope } from '../../src/node/control/update-authority.js';
import { reviewedHostUpdate } from '../helpers/host-update.js';

const outgoing = { version: '0.3.99', protocol: { major: 25, minor: 20 } };
const scope = () => ({ outgoing: structuredClone(outgoing), targetVersion: '0.4.0' });
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

function fixture(scoped = true, peer = outgoing) {
  let version: VersionResponse = peer;
  const commands: ControlRequest[] = [];
  const channels: Duplex[] = [];
  const review = reviewedHostUpdate();
  let reply: HostUpdateReply = { ok: true, ...review };
  let loseApply = false;
  const open = vi.fn(async () => {
    const channel = new Duplex({
      read() {},
      write(data: Buffer, _encoding, done) {
        const message = JSON.parse(data.toString()) as ControlRequest;
        commands.push(message);
        if (message.t === 'open' || message.t === 'renew')
          this.push(
            JSON.stringify({
              t: 'authority',
              generation: randomUUID(),
              token: 'cn_' + 'b'.repeat(64),
              validForMs: 45_000,
              port: 7434,
              version,
            }) + '\n',
          );
        if (message.t === 'host-update' && message.command.action === 'apply' && loseApply) {
          this.destroy();
          done();
          return;
        }
        if (message.t === 'host-update')
          this.push(
            JSON.stringify({
              t: 'host-update-result',
              request_id: message.request_id,
              result: reply,
            }) + '\n',
          );
        done();
      },
    });
    channels.push(channel);
    return channel;
  });
  const client = new HostControlClient(
    open,
    false,
    undefined,
    undefined,
    undefined,
    scoped ? scope() : undefined,
  );
  cleanups.push(() => client.close());
  return {
    client,
    loseApply: () => {
      loseApply = true;
    },
    commands,
    open,
    review,
    setVersion: (next: VersionResponse) => {
      version = next;
    },
    setReply: (next: HostUpdateReply) => {
      reply = next;
    },
  };
}

it('ordinary authority still rejects a different application major', async () => {
  const f = fixture(false);
  await expect(f.client.establish()).rejects.toThrow('does not match');
});
it('restricts inspected migration authority to exact private update actions, without API credentials', async () => {
  const f = fixture();
  await f.client.establish();
  expect(() => f.client.credential()).toThrow('no application credential');
  expect(() => f.client.resource(() => {})).toThrow('no application credential');
  expect(() => f.client.setVerifier(async () => {})).toThrow('application gateway');
  await expect(f.client.hostMaintenance({ action: 'status' })).rejects.toThrow('unavailable');
  await expect(
    f.client.hostUpdate({ action: 'begin', targets: [{ component: 'runtime', version: '0.4.0' }] }),
  ).rejects.toThrow('exact daemon target');
  await f.client.hostUpdate({ action: 'begin', targets: f.review.operation.targets });
  await expect(
    f.client.hostUpdate({ action: 'begin', targets: f.review.operation.targets }),
  ).rejects.toThrow('without replay');
  await expect(
    f.client.hostUpdate({
      action: 'cancel',
      reference: { id: randomUUID(), revision: 1 },
      reason: 'cancelled',
    }),
  ).rejects.toThrow('another operation');
  expect(f.commands.filter((m) => m.t === 'host-update')).toHaveLength(1);
});
it.each(['version', 'major', 'minor'] as const)(
  'permanently refuses changed inspected outgoing %s',
  async (field) => {
    const peer = structuredClone(outgoing);
    if (field === 'version') peer.version = '0.3.98';
    else peer.protocol[field]++;
    const f = fixture(true, peer);
    await expect(f.client.establish()).rejects.toThrow('identity changed');
    f.setVersion(outgoing);
    await f.client.establish();
    expect(f.open).toHaveBeenCalledOnce();
  },
);
it('observes only the exact staged replacement after one apply and never returns to outgoing authority', async () => {
  const f = fixture();
  await f.client.establish();
  const reference = { id: f.review.operation.id, revision: f.review.operation.revision };
  await f.client.hostUpdate({ action: 'begin', targets: f.review.operation.targets });
  await f.client.hostUpdate({
    action: 'apply',
    reference,
    frontend: PROTOCOL_VERSION,
    fingerprint: 'a'.repeat(64),
    interruption_approval: 'a'.repeat(64),
  });
  f.client.setTransportAvailable(false);
  f.setVersion({ version: '0.4.0', protocol: PROTOCOL_VERSION });
  await f.client.establish();
  await f.client.hostUpdate({ action: 'status', id: reference.id });
  await expect(
    f.client.hostUpdate({
      action: 'apply',
      reference,
      frontend: PROTOCOL_VERSION,
      fingerprint: 'a'.repeat(64),
    }),
  ).rejects.toThrow('observation-only');
  f.client.setTransportAvailable(false);
  f.setVersion(outgoing);
  await expect(f.client.establish()).rejects.toThrow('identity changed');
});
it.each(['early', 'version', 'minor'] as const)(
  'refuses an %s replacement outside verified activation',
  async (kind) => {
    const f = fixture();
    await f.client.establish();
    await f.client.hostUpdate({ action: 'begin', targets: f.review.operation.targets });
    if (kind !== 'early')
      await f.client.hostUpdate({
        action: 'apply',
        reference: { id: f.review.operation.id, revision: 2 },
        frontend: PROTOCOL_VERSION,
        fingerprint: 'a'.repeat(64),
      });
    f.client.setTransportAvailable(false);
    f.setVersion({
      version: kind === 'version' ? '0.4.1' : '0.4.0',
      protocol: { ...PROTOCOL_VERSION, minor: PROTOCOL_VERSION.minor + (kind === 'minor' ? 1 : 0) },
    });
    await expect(f.client.establish()).rejects.toThrow('identity changed');
  },
);
it('rejects legacy/current hosts and all profile or remote maintenance claims in migration mode', () => {
  for (const protocol of [
    { major: 25, minor: 6 },
    PROTOCOL_VERSION,
    { major: PROTOCOL_VERSION.major + 1, minor: 0 },
  ])
    expect(
      () => new HostUpdateOnlyScope({ ...scope(), outgoing: { ...outgoing, protocol } }),
    ).toThrow('supported older host');
  expect(
    () =>
      new HostControlClient(
        async () => {
          throw new Error('unused');
        },
        false,
        undefined,
        '0123456789',
        undefined,
        scope(),
      ),
  ).toThrow('profile or remote');
  expect(
    () =>
      new HostControlClient(
        async () => {
          throw new Error('unused');
        },
        false,
        undefined,
        undefined,
        {
          device: randomUUID(),
          peer: 'a'.repeat(64),
          account: 'fixture',
          host: randomUUID(),
          grant: randomUUID(),
        },
        scope(),
      ),
  ).toThrow('profile or remote');
});

it('observes a lost apply acknowledgement through the exact replacement without replay', async () => {
  const f = fixture();
  await f.client.establish();
  await f.client.hostUpdate({ action: 'begin', targets: f.review.operation.targets });
  f.loseApply();
  const apply = {
    action: 'apply' as const,
    reference: { id: f.review.operation.id, revision: 2 },
    frontend: PROTOCOL_VERSION,
    fingerprint: 'a'.repeat(64),
  };
  await expect(f.client.hostUpdate(apply)).rejects.toThrow();
  f.setVersion({ version: '0.4.0', protocol: PROTOCOL_VERSION });
  await f.client.establish();
  await f.client.hostUpdate({ action: 'status', id: f.review.operation.id });
  await expect(f.client.hostUpdate(apply)).rejects.toThrow('observation-only');
  expect(
    f.commands.filter(
      (command) => command.t === 'host-update' && command.command.action === 'apply',
    ),
  ).toHaveLength(1);
});
it('rejects a staged release different from the exact requested target', async () => {
  const f = fixture();
  await f.client.establish();
  const changed = structuredClone(f.review);
  changed.operation.stages[0]!.record.version = '0.4.1';
  f.setReply({ ok: true, ...changed });
  await expect(
    f.client.hostUpdate({ action: 'begin', targets: f.review.operation.targets }),
  ).rejects.toThrow('Host control was lost');
  expect(f.client.state).not.toBe('ready');
  const guard = new HostUpdateOnlyScope(scope());
  expect(() => guard.observed({ ok: true, ...changed })).toThrow('version changed');
});
