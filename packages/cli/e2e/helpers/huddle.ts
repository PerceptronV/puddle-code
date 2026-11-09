import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  huddleHistoryPageSchema,
  huddleOpenedSchema,
  huddleRunAcceptedSchema,
  huddleRuntimeInspectionSchema,
  huddleDefinitionSchema,
  huddleDocumentSchema,
  profileSchema,
  projectSchema,
  repoSchema,
} from '@puddle/shared';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { ipcPath, privatePath } from '@puddle/shared/node';
import { until } from '../helpers.js';

/** Use the packaged host's normal authority/API and editable Manual flow starter. */
export async function packagedHuddle(
  home: string,
  port: number,
  worktree: string,
  interval = false,
) {
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
    let document = opened.document;
    if (interval) {
      const definition = huddleDefinitionSchema.parse({
        ...document.definition,
        nodes: [
          ...document.definition.nodes,
          {
            id: 'clock',
            source: { kind: 'builtin', component: 'puddle.trigger.interval', version: 1 },
            parameters: { intervalMs: { kind: 'literal', value: 1000 } },
          },
          {
            id: 'clock-transform',
            source: { kind: 'local', manifest: 'nodes/transform/node.json' },
          },
          {
            id: 'clock-result',
            source: { kind: 'builtin', component: 'puddle.readout.result', version: 1 },
          },
        ],
        edges: [
          ...document.definition.edges,
          {
            id: 'tick',
            from: { node: 'clock', port: 'event' },
            to: { node: 'clock-transform', port: 'value' },
          },
          {
            id: 'clock-output',
            from: { node: 'clock-transform', port: 'completed' },
            to: { node: 'clock-result', port: 'value' },
          },
        ],
      });
      writeFileSync(
        join(worktree, '.puddle/huddle', definition.id, 'huddle.json'),
        JSON.stringify(definition),
      );
      document = huddleDocumentSchema.parse(
        await request(
          `/huddle/${profile.id}/definitions/${definition.id}?${new URLSearchParams({ project_id: project.id, worktree })}`,
        ),
      );
    }
    const started = huddleRuntimeInspectionSchema.parse(
      await request(`${prefix}/start`, { expected_digest: document.digest, variables: {} }),
    );
    if (!started.owner?.connected) throw new Error('Packaged huddle did not start');
    const target = started.owner.target;
    const executions = async () => {
      const history = huddleHistoryPageSchema.parse(
        await request(`${prefix}/history`, {
          owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
          collection: 'executions',
          after: 0,
        }),
      );
      if (history.collection !== 'executions') throw new Error('Wrong history collection');
      return history.records;
    };
    return {
      target,
      prefix,
      executions,
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
            return (await executions()).find(({ record }) => record.id === accepted.executionId)
              ?.record;
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
