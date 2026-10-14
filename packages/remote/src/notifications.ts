import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import webpush from 'web-push';
import type { Hono } from 'hono';
import {
  pushDispatchSchema,
  pushRegistrationSchema,
  pushSubscriptionSchema,
  type PushSubscriptionRecord,
  type EncryptedNotification,
} from '@puddle/shared';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import type { ServiceStore, HostRecord } from './store.js';
import type { RemoteConfig } from './config.js';
import { RateLimit } from './rate-limit.js';

const keySchema = z
  .object({ publicKey: z.string().min(80).max(100), privateKey: z.string().min(40).max(50) })
  .strict();
const lifetime = 90 * 24 * 60 * 60 * 1000;

/** The service routes opaque previews; only the approved device can decrypt host content. */
export class PushDelivery {
  readonly publicKey: string;
  private readonly keys: z.infer<typeof keySchema>;
  private readonly recent = new Map<string, number>();
  private pending = 0;
  private stopped = false;
  close(): void {
    this.stopped = true;
  }
  constructor(
    private readonly store: ServiceStore,
    private readonly config: RemoteConfig,
    private readonly send = webpush.sendNotification,
  ) {
    const path = join(config.home, 'push-keys.json');
    if (!existsSync(path)) atomicPrivateJson(path, webpush.generateVAPIDKeys());
    this.keys = keySchema.parse(readPrivateJson(path));
    this.publicKey = this.keys.publicKey;
  }

  register(host: HostRecord, device: string, value: PushSubscriptionRecord | null): void {
    const db = this.store.db;
    if (!value) {
      db.prepare('DELETE FROM push_subscriptions WHERE host = ? AND device = ?').run(
        host.id,
        device,
      );
      return;
    }
    const subscription = pushSubscriptionSchema.parse(value);
    const count = db
      .prepare('SELECT count(*) AS n FROM push_subscriptions WHERE host = ? AND device != ?')
      .get(host.id, device) as { n: number };
    if (count.n >= 64) throw new Error('Notification device quota reached');
    const expires = Math.min(Date.now() + lifetime, subscription.expirationTime ?? Infinity);
    if (expires <= Date.now()) throw new Error('Push subscription expired');
    db.prepare(
      'INSERT OR REPLACE INTO push_subscriptions(host, device, subscription, expires) VALUES (?, ?, ?, ?)',
    ).run(host.id, device, JSON.stringify(subscription), expires);
  }

  async notify(
    host: HostRecord,
    devices: string[],
    id: string,
    preview?: EncryptedNotification,
  ): Promise<{ accepted: number; failed: number }> {
    const outcome = { accepted: 0, failed: 0 };
    if (this.stopped) return outcome;
    const now = Date.now();
    for (const [key, at] of this.recent) if (at + 300_000 < now) this.recent.delete(key);
    const key = `${host.id}:${id}:${[...new Set(devices)].sort().join(',')}`;
    if (this.recent.has(key)) return outcome;
    if (this.pending >= 32 || this.recent.size >= 8192)
      throw new Error('Notification capacity unavailable');
    this.recent.set(key, now);
    this.pending++;
    try {
      const endpoints = new Set<string>();
      // Serial within each event: a host cannot fan out dozens of outbound sockets at once.
      for (const device of new Set(devices)) {
        if (this.stopped || !this.store.host(host.id)) break;
        const row = this.store.db
          .prepare(
            'SELECT subscription FROM push_subscriptions WHERE host = ? AND device = ? AND expires > ?',
          )
          .get(host.id, device, Date.now()) as { subscription: string } | undefined;
        if (!row) continue;
        const subscription = pushSubscriptionSchema.parse(JSON.parse(row.subscription));
        if (endpoints.has(subscription.endpoint)) continue;
        endpoints.add(subscription.endpoint);
        try {
          await this.send(
            subscription,
            JSON.stringify({ id, host: host.id, ...(preview ? { preview } : {}) }),
            {
              vapidDetails: { subject: this.config.service, ...this.keys },
              TTL: 120,
              timeout: 5000,
              urgency: 'normal',
              topic: id.replaceAll('-', ''),
            },
          );
          outcome.accepted++;
        } catch (error) {
          outcome.failed++;
          const code = (error as { statusCode?: number }).statusCode;
          if (!this.stopped && (code === 404 || code === 410))
            this.store.db
              .prepare(
                'DELETE FROM push_subscriptions WHERE host = ? AND device = ? AND subscription = ?',
              )
              .run(host.id, device, row.subscription);
          // Never log vendor endpoints or response bodies (subscription credentials).
        }
      }
      return outcome;
    } finally {
      this.pending--;
    }
  }
}

export function installPushRoutes(app: Hono, store: ServiceStore, delivery: PushDelivery): void {
  const limits = new RateLimit(60);
  for (const path of ['/remote/push/register', '/remote/push/notify']) {
    app.post(path, async (c) => {
      if (c.req.header('origin') !== undefined || c.req.header('cookie') !== undefined)
        return c.json({ error: 'Host notifications require the local connector' }, 403);
      const body: unknown = await c.req.json();
      const registration = path.endsWith('/register')
        ? pushRegistrationSchema.safeParse(body)
        : null;
      const dispatch = path.endsWith('/notify') ? pushDispatchSchema.safeParse(body) : null;
      const value = registration?.success
        ? registration.data
        : dispatch?.success
          ? dispatch.data
          : null;
      if (!value) return c.json({ error: 'Invalid notification request' }, 400);
      const host = store.authenticate(value.credential);
      if (!host) return c.json({ error: 'Host registration unavailable' }, 403);
      if (!limits.take(host.id)) return c.json({ error: 'Too many notifications' }, 429);
      if (registration?.success)
        delivery.register(host, registration.data.device, registration.data.subscription);
      if (dispatch?.success)
        return c.json(
          await delivery.notify(
            host,
            dispatch.data.devices,
            dispatch.data.id,
            dispatch.data.preview,
          ),
        );
      return c.body(null, 204);
    });
  }
}
