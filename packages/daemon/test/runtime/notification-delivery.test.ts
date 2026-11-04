import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentNotification, NotificationContent, RuntimeAttention } from '@puddle/shared';
import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import {
  RuntimeNotifications,
  RUNTIME_ATTENTION_MAX_AGE_MS,
} from '../../src/runtime/notifications.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';

function fixture() {
  const f = runtimeDatabase('interactive');
  f.db
    .prepare("UPDATE runtime_bindings SET state = 'running' WHERE runtime_id = ?")
    .run(f.binding.runtime_id);
  f.sessions.setStatus(f.session.id, 'waiting_input');
  let cursor = 0;
  const observe = (createdAt = new Date().toISOString()) => {
    const attention: RuntimeAttention = {
      id: randomUUID(),
      segment_id: f.binding.active_segment_id!,
      reason: 'waiting_input',
      created_at: createdAt,
    };
    f.reconciler.attention.observe(f.binding.runtime_id, ++cursor, f.session.id, attention);
    return attention;
  };
  const emitted: AgentNotification[] = [];
  const content: NotificationContent = {
    title: 'Current work',
    body: 'Private preview',
    project: f.project.id,
    session: f.session.id,
  };
  const deliveries: RuntimeNotifications[] = [];
  let ready = true;
  const delivery = (read: () => Promise<NotificationContent> = async () => content) => {
    const result = new RuntimeNotifications({
      store: f.reconciler.attention,
      runtimes: f.runtimes,
      sessions: f.sessions,
      reconciler: f.reconciler,
      ready: () => ready,
      content: read,
      emit: (event) => emitted.push(event),
    });
    deliveries.push(result);
    return result;
  };
  return {
    ...f,
    observe,
    emitted,
    content,
    delivery,
    setReady(value: boolean) {
      ready = value;
    },
    async close() {
      for (const notifier of deliveries) notifier.close();
      await f.reconciler.close();
      f.db.close();
    },
  };
}

it('coalesces offline attention and commits delivery before emitting, including failed writes and replacement', async () => {
  const f = fixture();
  try {
    let latest!: RuntimeAttention;
    for (let i = 0; i < 100; i++) latest = f.observe();
    expect(f.reconciler.attention.pending()).toHaveLength(1);
    // A late older inspection cannot restore an obsolete condition.
    f.reconciler.attention.observe(f.binding.runtime_id, 1, f.session.id, null);
    f.db.exec(
      "CREATE TRIGGER fail_delivery BEFORE UPDATE ON runtime_attention WHEN NEW.delivered_id IS NOT OLD.delivered_id BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END",
    );
    const first = f.delivery();
    await first.flush();
    expect(f.emitted).toEqual([]);
    expect(f.reconciler.attention.pending()).toHaveLength(1);
    f.db.exec('DROP TRIGGER fail_delivery');
    await first.flush();
    expect(f.emitted).toMatchObject([{ id: latest.id, content: f.content }]);
    expect(f.reconciler.attention.pending()).toEqual([]);
    first.close();
    const replacement = f.delivery();
    // Re-inspection of the same live owner does not reset its delivery claim.
    f.reconciler.attention.observe(f.binding.runtime_id, 101, f.session.id, latest);
    await replacement.flush();
    expect(f.emitted).toHaveLength(1);
    expect(JSON.stringify(f.events.list(f.session.id))).not.toContain('Private preview');
  } finally {
    await f.close();
  }
});

it('defers alerts until owner reconciliation is complete', async () => {
  const f = fixture();
  try {
    const attention = f.observe();
    f.setReady(false);
    const notifier = f.delivery();
    await notifier.flush();
    expect(f.emitted).toEqual([]);
    expect(f.reconciler.attention.pending()).toHaveLength(1);
    f.setReady(true);
    await notifier.flush();
    expect(f.emitted).toMatchObject([{ id: attention.id }]);
  } finally {
    await f.close();
  }
});

it('continues beyond a full page of unavailable owners', async () => {
  const f = fixture();
  let notifier: RuntimeNotifications | undefined;
  try {
    let previous = f.binding.runtime_id;
    const available = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    for (let i = 0; i < 35; i++) {
      f.runtimes.finish(previous, 'exited', () => {});
      const id = i === 34 ? available : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      f.runtimes.prepare({
        identity: {
          ...f.launch.identity,
          runtime_id: id,
          incarnation: randomUUID(),
          launch_id: randomUUID(),
        },
        build: 'runtime-test',
        protocol: RUNTIME_PROTOCOL_VERSION,
        releasePath: f.directory,
      });
      f.db.prepare("UPDATE runtime_bindings SET state = 'running' WHERE runtime_id = ?").run(id);
      f.reconciler.attention.observe(id, 1, f.session.id, {
        id: randomUUID(),
        segment_id: id,
        reason: 'waiting_input',
        created_at: new Date().toISOString(),
      });
      previous = id;
    }
    notifier = new RuntimeNotifications({
      store: f.reconciler.attention,
      runtimes: f.runtimes,
      sessions: f.sessions,
      reconciler: f.reconciler,
      ready: (id) => id === available,
      content: async () => f.content,
      emit: (event) => f.emitted.push(event),
    });
    await notifier.flush();
    expect(f.emitted).toEqual([]);
    await notifier.flush();
    expect(f.emitted).toHaveLength(1);
  } finally {
    notifier?.close();
    await f.close();
  }
});

it.each(['expired', 'stop', 'replacement'] as const)(
  'suppresses %s attention without leaving a delivery backlog',
  async (cause) => {
    const f = fixture();
    try {
      f.observe(
        cause === 'expired'
          ? new Date(Date.now() - RUNTIME_ATTENTION_MAX_AGE_MS - 1000).toISOString()
          : undefined,
      );
      if (cause === 'stop')
        f.runtimes.requestStop(f.binding.runtime_id, f.session.id, f.binding.active_segment_id!);
      if (cause === 'replacement') {
        f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
        f.runtimes.useLegacyTerminals(f.session.id);
      }
      const notifier = f.delivery(async () => {
        throw new Error('Suppressed attention must not read a preview');
      });
      await notifier.flush();
      expect(f.emitted).toEqual([]);
      expect(f.reconciler.attention.pending()).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it.each(['working', 'newer', 'shutdown'] as const)(
  'rechecks %s while a preview is pending',
  async (change) => {
    const f = fixture();
    try {
      f.observe();
      let release!: (content: NotificationContent) => void;
      const preview = new Promise<NotificationContent>((resolve) => {
        release = resolve;
      });
      const notifier = f.delivery(() => preview);
      const pending = notifier.flush();
      let newer: RuntimeAttention | undefined;
      if (change === 'working') {
        f.sessions.setStatus(f.session.id, 'running');
        f.reconciler.attention.observe(f.binding.runtime_id, 2, f.session.id, null);
      } else if (change === 'newer') newer = f.observe();
      else notifier.close();
      release(f.content);
      await pending;
      expect(f.emitted).toEqual([]);
      if (newer) {
        await notifier.flush();
        expect(f.emitted).toMatchObject([{ id: newer.id }]);
      } else if (change === 'shutdown') expect(f.reconciler.attention.pending()).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);
