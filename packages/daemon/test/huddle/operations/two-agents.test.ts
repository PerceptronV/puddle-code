import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  encodeHuddleAgentTarget,
  huddleDefinitionSchema,
  RUNTIME_PROTOCOL_VERSION,
  coreHuddleComponents,
  type HuddleAgentTarget,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { agentOwnerFixture } from '../../helpers/huddle/agent-owner.js';
import { launchOwner, waitForOwner } from '../../helpers/runtime-fixture.js';
import { runtimeDirectory, readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
import { installHuddleTemplate } from '../../../src/huddle/templates/install.js';
import { captureHuddleDefinition } from '../../../src/huddle/definitions/capture.js';
import { HuddleAgentDispatcher } from '../../../src/huddle/operations/dispatch/service.js';

it('executes shipped prompt/review nodes through two exact agent conversations and exits bounded feedback on approval', async () => {
  let reviewer: HuddleAgentTarget;
  const f = await agentOwnerFixture(false, async (base, scope) => {
    const session = base.sessions.create({
      id: randomUUID(),
      project_id: base.project.id,
      account_id: base.account!.id,
      worktree_path: base.home,
      base_branch: 'main',
      branch: 'main',
      separate_branch: false,
      branch_owned: false,
      kind: 'agent',
      agent_type: 'runtime-test',
      agent_mode: 'interactive',
      title: 'Reviewer',
      skip_permissions: false,
    });
    const launch = structuredClone(base.launch);
    Object.assign(launch.identity, {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      session_id: session.id,
    });
    const directory = runtimeDirectory(base.home, launch.identity.runtime_id);
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    base.runtimes.prepare({
      identity: launch.identity,
      build: 'runtime-test',
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: directory,
    });
    const owner = launchOwner(base.home, launch.identity.runtime_id, 'provider-owner.mjs');
    await waitForOwner(owner, directory);
    await base.connections.connectOwner(launch.identity.runtime_id);
    reviewer = {
      runtimeId: launch.identity.runtime_id,
      incarnation: launch.identity.incarnation,
      sessionId: session.id,
      projectId: base.project.id,
      worktree: launch.identity.canonical_worktree_path,
    };
    writeFileSync(join(base.home, 'test-review-output'), '');
    const created = huddleDefinitionSchema.parse({
      format: 1,
      id: base.runtimes.get(scope.owner.runtime_id)!.huddle_id!,
      name: 'Two agents',
      nodes: [],
      edges: [],
    });
    const root = join(scope.owner.canonical_worktree_path, '.puddle/huddle', created.id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'huddle.json'), JSON.stringify(created));
    const input = {
      project_id: base.project.id,
      worktree: scope.owner.canonical_worktree_path,
      huddle_id: created.id,
    };
    installHuddleTemplate(
      input.worktree,
      { ...input, template: 'prompt-agent', component: 'coder' },
      () => {},
    );
    installHuddleTemplate(
      input.worktree,
      { ...input, template: 'review-agent', component: 'reviewer' },
      () => {},
    );
    const definition = huddleDefinitionSchema.parse({
      ...created,
      nodes: [
        { id: 'run', source: { kind: 'builtin', component: 'puddle.trigger.manual', version: 1 } },
        ...(['coder', 'reviewer'] as const).map((id) => ({
          id,
          source: { kind: 'local', manifest: `nodes/${id}/node.json` },
          parameters: {
            worktree: { kind: 'literal', value: input.worktree },
            agent: {
              kind: 'literal',
              value: id === 'coder' ? scope.target.sessionId : reviewer.sessionId,
            },
            prompt: { kind: 'literal', value: '{{input}}' },
          },
        })),
        {
          id: 'result',
          source: { kind: 'builtin', component: 'puddle.readout.result', version: 1 },
        },
      ],
      edges: [
        { id: 'seed', from: { node: 'run', port: 'event' }, to: { node: 'coder', port: 'value' } },
        {
          id: 'review',
          from: { node: 'coder', port: 'completed' },
          to: { node: 'reviewer', port: 'value' },
        },
        {
          id: 'again',
          from: { node: 'reviewer', port: 'completed' },
          to: { node: 'coder', port: 'value' },
          feedback: { maxRounds: 3, while: { path: ['complete'], equals: false } },
        },
        {
          id: 'result',
          from: { node: 'reviewer', port: 'completed' },
          to: { node: 'result', port: 'value' },
        },
      ],
    });
    writeFileSync(
      join(input.worktree, '.puddle/huddle', created.id, 'huddle.json'),
      JSON.stringify(definition),
    );
    const snapshot = await captureHuddleDefinition(
      input.worktree,
      created.id,
      coreHuddleComponents,
    );
    expect(snapshot.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const bindings = {
      coder: { worktree: input.worktree, agent: encodeHuddleAgentTarget(scope.target) },
      reviewer: { worktree: input.worktree, agent: encodeHuddleAgentTarget(reviewer) },
    };
    return { snapshot, bindings };
  });
  const dispatcher = new HuddleAgentDispatcher(f);
  dispatcher.start();
  try {
    await f.run('Implement a small change');
    await expect
      .poll(
        async () => {
          const page = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
          return page.t === 'records' && page.rows.map((row) => JSON.parse(row.body).state);
        },
        { timeout: 15000 },
      )
      .toEqual(['completed']);
    const feedback = JSON.stringify({
      complete: false,
      feedback: 'review:1:reply:1:Implement a small change',
    });
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({
      count: 2,
      prompt: feedback,
    });
    expect(readRuntimeJson(join(f.home, `${reviewer!.sessionId}.turns.json`))).toMatchObject({
      count: 2,
      prompt: `reply:2:${feedback}`,
    });
    await expect
      .poll(() => f.db.prepare('SELECT COUNT(*) AS n FROM runtime_turns WHERE consumed = 1').get())
      .toEqual({ n: 4 });
    expect(f.db.prepare('SELECT DISTINCT runtime_id FROM huddle_runtime_turns').all()).toHaveLength(
      2,
    );
  } finally {
    await dispatcher.close();
    await f.close();
  }
});
