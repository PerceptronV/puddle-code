import { randomUUID } from 'node:crypto';
import { HUDDLE_RUNTIME_CAPABILITIES, RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { HuddlePlacements } from '../../../src/db/stores/huddle/placements.js';
import type { HuddleTurnScope } from '../../../src/huddle/operations/turns/scope.js';
import type { runtimeDatabase } from '../runtime-database.js';

/** Synthetic source owner authority; agent-owner process tests exercise the real destination. */
export function huddleTurnScope(f: ReturnType<typeof runtimeDatabase>): HuddleTurnScope {
  const session = new HuddlePlacements(f.db).open({
    projectId: f.project.id,
    worktree: f.home,
    huddleId: randomUUID().replaceAll('-', ''),
    branch: 'main',
    title: 'Agent graph',
  }).session;
  const owner = {
    ...f.launch.identity,
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    session_id: session.id,
  };
  f.runtimes.prepare({
    identity: owner,
    build: 'runtime-test',
    protocol: RUNTIME_PROTOCOL_VERSION,
    releasePath: f.directory,
    huddle: { id: session.huddle_id!, capabilities: HUDDLE_RUNTIME_CAPABILITIES },
  });
  f.db
    .prepare("UPDATE runtime_bindings SET state = 'running' WHERE runtime_id = ?")
    .run(owner.runtime_id);
  return {
    owner,
    executionId: randomUUID(),
    invocationId: randomUUID(),
    operationId: randomUUID(),
    activationId: randomUUID(),
    revision: 'a'.repeat(64),
    target: {
      runtimeId: f.binding.runtime_id,
      incarnation: f.binding.incarnation,
      sessionId: f.session.id,
      projectId: f.project.id,
      worktree: f.launch.identity.canonical_worktree_path,
    },
  };
}
