import { randomUUID } from 'node:crypto';
import {
  notificationDeliverySchema,
  pushDispatchResultSchema,
  type ConnectorConfig,
  type PushPreference,
  type NotificationContent,
} from '@puddle/shared';
import type { DeviceStore } from './devices.js';
import { encryptNotification } from './notification-preview.js';

/** No daemon lease or browser impersonation; previews are encrypted for each approved device. */
export class ConnectorNotifications {
  private pending = 0;
  private readonly updates = new Map<string, Promise<unknown>>();
  constructor(
    private readonly config: ConnectorConfig,
    private readonly devices: DeviceStore,
    private readonly enabled: () => boolean,
    private readonly send = fetch,
  ) {}

  private valid(id: string): boolean {
    const device = this.devices.list().find((entry) => entry.id === id);
    return this.enabled() && !!device && this.devices.valid(id, device.peer, this.config.account);
  }
  private async request(path: string, body: object, signal?: AbortSignal): Promise<Response> {
    const response = await this.send(`${this.config.service}/remote/push/${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, credential: this.config.credential }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Background notifications could not reach the push service.');
    return response;
  }
  update(
    device: string,
    preference: PushPreference,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<unknown> {
    const task = (this.updates.get(device) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.apply(device, preference, signal, current));
    this.updates.set(device, task);
    void task
      .finally(() => {
        if (this.updates.get(device) === task) this.updates.delete(device);
      })
      .catch(() => {});
    return task;
  }
  private async apply(
    device: string,
    preference: PushPreference,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<unknown> {
    if (!current() || !this.valid(device)) throw new Error('Browser access expired');
    await this.request('register', { device, subscription: preference.subscription }, signal);
    if (!current() || !this.valid(device)) {
      // A revoke/cancel during registration must not leave a live host subscription.
      this.devices.setNotifications(device, false);
      await this.request('register', { device, subscription: null }).catch(() => {});
      throw new Error('Browser access expired');
    }
    this.devices.setNotifications(device, preference.subscription !== null, preference.preview_key);
    return { enabled: preference.subscription !== null };
  }
  async test(device: string, signal: AbortSignal): Promise<unknown> {
    if (!this.valid(device) || !this.devices.notificationDevices().includes(device))
      throw new Error('Enable background notifications for this host first.');
    const result = await this.request('notify', { devices: [device], id: randomUUID() }, signal);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (result.body)
      for await (const chunk of result.body) {
        size += chunk.byteLength;
        if (size > 4096) throw new Error('Invalid push service response');
        chunks.push(chunk);
      }
    const body = Buffer.concat(chunks).toString('utf8');
    const outcome = pushDispatchResultSchema.parse(JSON.parse(body));
    return notificationDeliverySchema.parse(
      outcome.accepted > 0
        ? {
            state: 'shown',
            message:
              'The push service accepted the notification. Check this device for its banner.',
          }
        : {
            state: 'failed',
            message:
              'Push delivery failed. Disable and re-enable notifications on this device, then try again.',
          },
    );
  }
  async notify(id: string, content?: NotificationContent): Promise<void> {
    if (!this.enabled() || this.pending >= 16) return;
    this.pending++;
    try {
      const devices = this.devices.notificationDevices().slice(0, 64);
      const deadline = Date.now() + 30_000;
      await Promise.all(
        Array.from({ length: Math.min(4, devices.length) }, async () => {
          for (;;) {
            const device = devices.shift();
            if (!device || Date.now() >= deadline) return;
            if (!this.valid(device)) continue;
            const key = this.devices.notificationKey(device);
            const preview =
              content && key ? encryptNotification(content, key, this.config.host, id) : undefined;
            await this.request('notify', {
              devices: [device],
              id,
              ...(preview ? { preview } : {}),
            }).catch(() => {});
          }
        }),
      );
    } finally {
      this.pending--;
    }
  }
}
