import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import {
  encodeHuddleAgentTarget,
  huddleStarterFiles,
  RUNTIME_PROTOCOL_VERSION,
  coreHuddleComponents,
  type HuddleAgentTarget,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { agentOwnerFixture } from '../../helpers/huddle/agent-owner.js';
import { launchOwner, waitForOwner } from '../../helpers/runtime-fixture.js';
import { runtimeDirectory, readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
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
    const id = base.runtimes.get(scope.owner.runtime_id)!.huddle_id!;
    const input = { worktree: scope.owner.canonical_worktree_path };
    const starter = huddleStarterFiles('review-loop', id, 'Two agents', input.worktree);
    const root = join(input.worktree, '.puddle/huddle', id);
    for (const node of starter.definition.nodes) {
      if (node.id === 'coder' || node.id === 'reviewer')
        node.parameters.agent = {
          kind: 'literal',
          value: node.id === 'coder' ? scope.target.sessionId : reviewer.sessionId,
        };
    }
    starter.files['huddle.json'] = JSON.stringify(starter.definition);
    for (const [path, text] of Object.entries(starter.files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const snapshot = await captureHuddleDefinition(input.worktree, id, coreHuddleComponents);
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
    const operation = await f.run('Implement a small change');
    await expect
      .poll(
        async () => {
          const page = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
          return page.t === 'records' && page.rows.map((row) => JSON.parse(row.body).state);
        },
        { timeout: 15000 },
      )
      .toEqual(['completed']);
    const coderTurns = readRuntimeJson(join(f.home, `${f.session.id}.turns.json`));
    const reviewerTurns = readRuntimeJson(join(f.home, `${reviewer!.sessionId}.turns.json`));
    expect(coderTurns).toMatchObject({
      count: 2,
      prompt: expect.stringContaining('"complete":false'),
    });
    expect(reviewerTurns).toMatchObject({
      count: 2,
      prompt: expect.stringContaining('Implement a small change'),
    });
    const history = await f.huddle.request({
      t: 'records',
      collection: 'invocations',
      parent: operation.scope.executionId,
      after: 0,
    });
    expect(history.t).toBe('records');
    if (history.t === 'records') {
      const results = history.rows
        .map((row) => JSON.parse(row.body))
        .filter((row) => row.node === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        state: 'completed',
        inputs: { value: { complete: true } },
      });
    }
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
