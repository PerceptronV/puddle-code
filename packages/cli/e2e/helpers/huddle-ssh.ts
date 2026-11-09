import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  huddleHistoryPageSchema,
  huddleRunAcceptedSchema,
  huddleRuntimeInspectionSchema,
  huddleTriggerInputSchema,
} from '@puddle/shared';
import { acquireAuthority } from '../../src/lib/auth/connection-authority.js';
import { openTunnel, type Tunnel } from '../../src/lib/transport/tunnel.js';
import { loopbackSsh } from '../../test/helpers/loopback-ssh.js';
import { until } from '../helpers.js';
import type { packagedHuddle } from './huddle.js';

/** Close the actual SSH control connection and forward, then inspect through a fresh lease. */
export async function checkHuddleSsh(
  home: string,
  port: number,
  huddle: Awaited<ReturnType<typeof packagedHuddle>>,
) {
  const ssh = await loopbackSsh(home);
  const open = async () => {
    const transport = ssh.transport();
    let authority: Awaited<ReturnType<typeof acquireAuthority>> | undefined;
    let tunnel: Tunnel | undefined;
    const close = async () => {
      authority?.close();
      await tunnel?.close();
      transport.dispose();
    };
    try {
      await transport.open();
      authority = await acquireAuthority(transport);
      tunnel = await openTunnel(transport, port, { sshBinary: ssh.binary });
      return {
        close,
        async request(suffix: string, body?: object) {
          const response = await fetch(
            `http://127.0.0.1:${tunnel!.localPort}/api${huddle.prefix}/${suffix}`,
            {
              method: body === undefined ? 'GET' : 'POST',
              headers: {
                authorization: `Bearer ${authority!.credential()}`,
                'content-type': 'application/json',
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!response.ok) throw new Error(`SSH huddle ${suffix}: ${await response.text()}`);
          return response.json();
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  };
  let connection: Awaited<ReturnType<typeof open>> | undefined;
  try {
    connection = await open();
    const before = huddleRuntimeInspectionSchema.parse(await connection.request('runtime'));
    if (!before.owner?.connected) throw new Error('SSH huddle owner is unavailable');
    expect(before.owner.target).toEqual(huddle.target);
    const accepted = huddleRunAcceptedSchema.parse(
      await connection.request('run', {
        target: huddle.target,
        node: 'run',
        event_id: randomUUID(),
        data: 'Submitted over SSH',
      }),
    );
    await connection.close();
    connection = undefined;
    expect(ssh.disconnect()).toBe(true);
    const disconnectedAt = Date.now();
    // Host-side observation is read-only: only the owner timer can admit this new execution.
    const offline = await until(
      async () =>
        (await huddle.executions()).find(
          ({ record }) => record.state === 'completed' && record.acceptedAt > disconnectedAt,
        ),
      (value) => !!value,
    );
    connection = await open();
    const after = huddleRuntimeInspectionSchema.parse(await connection.request('runtime'));
    if (!after.owner?.connected) throw new Error('SSH huddle owner did not reconnect');
    expect(after.owner.target).toEqual(huddle.target);
    const owner = { runtimeId: huddle.target.runtimeId, incarnation: huddle.target.incarnation };
    const history = huddleHistoryPageSchema.parse(
      await connection.request('history', {
        owner,
        collection: 'executions',
        after: 0,
      }),
    );
    if (history.collection !== 'executions') throw new Error('Wrong SSH history collection');
    expect(history.records.filter(({ record }) => record.id === accepted.executionId)).toHaveLength(
      1,
    );
    expect(
      history.records.find(({ record }) => record.id === accepted.executionId)?.record.state,
    ).toBe('completed');
    expect(history.records.find(({ record }) => record.id === offline!.record.id)?.record).toEqual(
      offline!.record,
    );
    const input = huddleTriggerInputSchema.parse(
      await connection.request('history/input', {
        owner,
        execution_id: offline!.record.id,
      }),
    );
    expect(input.event.source).toEqual({
      node: 'clock',
      component: 'puddle.trigger.interval',
      version: 1,
    });
    expect(input.event.executionId).toBe(offline!.record.id);
  } finally {
    try {
      await connection?.close();
    } finally {
      await ssh.close();
    }
  }
}
