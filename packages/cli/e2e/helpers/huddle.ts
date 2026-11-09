import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { expect } from 'vitest';
import {
  huddleHistoryPageSchema,
  huddleOpenedSchema,
  huddleRunAcceptedSchema,
  huddleRuntimeInspectionSchema,
  profileSchema,
  projectSchema,
  repoSchema,
} from '@puddle/shared';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { ipcPath, privatePath } from '@puddle/shared/node';
import { until } from '../helpers.js';

/** Use the packaged host's normal authority/API and editable Manual flow starter. */
export async function packagedHuddle(home: string, port: number, worktree: string) {
  const socket = ipcPath(home, 'host');
  privatePath(socket);
  const authority = new HostControlClient(async () => connect(socket), true);
  await authority.establish();
  const request = async (path: string, body?: object) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${authority.credential()}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Packaged huddle ${path}: ${await response.text()}`);
    return response.json();
  };
  let prefix: string | undefined;
  const stop = async () => {
    try {
      if (prefix) {
        const current = huddleRuntimeInspectionSchema.parse(await request(`${prefix}/runtime`));
        if (current.owner?.connected)
          await request(`${prefix}/stop`, { target: current.owner.target });
        else if (current.owner || current.unresolved)
          throw new Error('Packaged huddle owner requires cleanup inspection');
      }
    } finally {
      authority.close();
    }
  };
  try {
    const profile = profileSchema.parse(await request('/profiles', { name: 'packaged-huddle' }));
    const repo = repoSchema.parse(await request('/repos', { path: worktree }));
    const project = projectSchema.parse(
      await request('/projects', {
        name: 'Huddle fixture',
        profile_id: profile.id,
        repo_id: repo.id,
      }),
    );
    const opened = huddleOpenedSchema.parse(
      await request(`/huddle/${profile.id}/definitions`, {
        project_id: project.id,
        worktree,
        name: 'Runtime selection continuity',
        template: 'manual',
      }),
    );
    prefix = `/huddle/${profile.id}/sessions/${opened.session.id}`;
    const started = huddleRuntimeInspectionSchema.parse(
      await request(`${prefix}/start`, { expected_digest: opened.document.digest, variables: {} }),
    );
    if (!started.owner?.connected) throw new Error('Packaged huddle did not start');
    const target = started.owner.target;
    return {
      target,
      stop,
      async run(value: string) {
        const current = huddleRuntimeInspectionSchema.parse(await request(`${prefix}/runtime`));
        if (!current.owner?.connected) throw new Error('Packaged huddle disconnected');
        expect(current.owner.target).toEqual(target);
        const accepted = huddleRunAcceptedSchema.parse(
          await request(`${prefix}/run`, {
            target,
            node: 'run',
            event_id: randomUUID(),
            data: value,
          }),
        );
        const owner = { runtimeId: target.runtimeId, incarnation: target.incarnation };
        await until(
          async () => {
            const history = huddleHistoryPageSchema.parse(
              await request(`${prefix}/history`, { owner, collection: 'executions', after: 0 }),
            );
            if (history.collection !== 'executions') throw new Error('Wrong history collection');
            return history.records.find(({ record }) => record.id === accepted.executionId)?.record;
          },
          (record) => {
            if (record && ['failed', 'cancelled', 'interrupted'].includes(record.state))
              throw new Error(`Packaged huddle execution ${record.state}: ${record.error}`);
            return record?.state === 'completed';
          },
        );
        const history = huddleHistoryPageSchema.parse(
          await request(`${prefix}/history`, {
            owner,
            collection: 'invocations',
            parent: accepted.executionId,
            after: 0,
          }),
        );
        if (history.collection !== 'invocations') throw new Error('Wrong history collection');
        expect(history.records.map(({ record }) => record.node).sort()).toEqual([
          'result',
          'transform',
        ]);
        expect(
          history.records.find(({ record }) => record.node === 'transform')?.record.result,
        ).toEqual({ completed: value });
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
