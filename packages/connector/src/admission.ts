import {
  CONNECTION_POLICY,
  REMOTE_POLICY,
  type RemoteAdminRequest,
  type RemoteAdminResponse,
} from '@puddle/shared';
import type { EncryptedChannel } from '@puddle/remote-transport';
import type { DeviceStore } from './devices.js';
import { Participation } from './participation.js';
import { RemoteUpstream } from './upstream.js';

export interface AdmissionHost {
  home: string;
  account: string;
  devices: DeviceStore;
  enabled(): boolean;
  admin(request: RemoteAdminRequest): RemoteAdminResponse;
}

/** Admission precedes authority creation; the relay has no input into the host decision. */
export async function admit(channel: EncryptedChannel, host: AdmissionHost): Promise<void> {
  let stopped = false;
  let upstream: RemoteUpstream | null = null;
  let participation: Participation | null = null;
  let deviceId: string | null = null;
  const valid = () =>
    !stopped &&
    host.enabled() &&
    participation?.valid() === true &&
    deviceId !== null &&
    host.devices.valid(deviceId, channel.peer, host.account) &&
    upstream?.authority.state === 'ready';
  const close = () => {
    if (stopped) return;
    stopped = true;
    channel.close();
    upstream?.dispose();
  };
  const messages = channel.messages();
  let helloTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    close,
    REMOTE_POLICY.handshakeMs,
  );
  let guard: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let offDevices: (() => void) | undefined;
  try {
    const first = await messages.next();
    clearTimeout(helloTimer);
    helloTimer = undefined;
    if (
      first.done ||
      first.value.t !== 'hello' ||
      first.value.account !== host.account ||
      !host.enabled()
    )
      throw new Error('Browser is not authorised');
    const hello = first.value;
    let device = hello.invitation
      ? host.devices.enrol(hello.invitation, channel.peer, host.account, hello.label)
      : (host.devices.find(channel.peer, host.account) ??
        host.devices.pending(channel.peer, host.account));
    if (!device) throw new Error('Browser pairing is required');
    if (device.status === 'pending') {
      await channel.send({ t: 'pending', device });
      const pending = device;
      while (!stopped && !channel.closed && host.enabled() && Date.now() < pending.expires) {
        device = host.devices.find(channel.peer, host.account);
        if (device?.id === pending.id) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      if (
        !device ||
        device.id !== pending.id ||
        stopped ||
        !host.devices.valid(device.id, channel.peer, host.account)
      )
        throw new Error('Browser pairing was not approved');
    }
    deviceId = device.id;
    participation = new Participation();
    upstream = new RemoteUpstream(host.home, channel, valid, close);
    await upstream.authority.establish();
    // Pairing may take five minutes. Participation starts with admission, not with the invitation.
    const active = participation;
    const lease = upstream;
    const authorised = () =>
      !stopped &&
      host.enabled() &&
      active.valid() &&
      host.devices.valid(device!.id, channel.peer, host.account) &&
      lease.authority.state === 'ready';
    offDevices = host.devices.onChange(() => {
      if (!authorised()) close();
    });
    await channel.send({
      t: 'admitted',
      generation: lease.authority.generation!,
      device: deviceId,
    });
    const challenge = () => {
      if (!authorised()) return close();
      const nonce = active.challenge();
      if (nonce)
        void channel
          .send({ t: 'challenge', nonce, generation: lease.authority.generation! })
          .catch(close);
    };
    guard = setInterval(() => {
      if (!authorised()) close();
    }, 250);
    heartbeat = setInterval(challenge, CONNECTION_POLICY.participationMs);
    challenge();
    for await (const message of messages) {
      if (!authorised()) break;
      if (message.t === 'participate') {
        const at =
          message.generation === lease.authority.generation ? active.accept(message.nonce) : null;
        if (at === null || !lease.participate(message.resources, at)) break;
        host.devices.touch(deviceId);
      } else if (message.t === 'request') {
        void lease.request(message).catch(close);
      } else if (message.t === 'stream') lease.openStream(message.id);
      else if (message.t === 'terminal') void lease.terminal(message).catch(close);
      else if (message.t === 'cancel') lease.cancel(message.id);
      else if (message.t === 'admin') {
        lease.reserve(message.id);
        const result = host.admin(message.request);
        await channel.send({ t: 'admin-result', id: message.id, result });
      } else break;
    }
  } catch {
    // No parser errors, keys, invitations or terminal content enter diagnostics.
    const approved =
      deviceId !== null &&
      host.enabled() &&
      host.devices.valid(deviceId, channel.peer, host.account);
    await channel
      .send({
        t: 'error',
        code: approved ? 'unavailable' : 'rejected',
        message: approved
          ? 'Host connection is unavailable. Reconnecting…'
          : 'Remote access requires pairing.',
      })
      .catch(() => {});
  } finally {
    clearTimeout(helloTimer);
    clearInterval(guard);
    clearInterval(heartbeat);
    offDevices?.();
    close();
  }
}
