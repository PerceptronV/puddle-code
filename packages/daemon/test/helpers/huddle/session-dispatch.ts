import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionHuddleTrigger } from '@puddle/shared';
import { huddleExecutionFixture } from './execution.js';
import { withTrigger } from './trigger.js';
import { HuddleSessionFeed } from '../../../src/huddle/triggers/sessions/feed.js';
import { HuddleSessionDispatcher } from '../../../src/huddle/triggers/sessions/dispatcher.js';

export async function sessionDispatchFixture(selected = false) {
  const f = await huddleExecutionFixture();
  const watched = f.sessions.create({
    id: randomUUID(),
    project_id: f.project.id,
    account_id: null,
    worktree_path: f.home,
    base_branch: 'main',
    branch: 'main',
    separate_branch: false,
    kind: 'terminal',
    agent_type: null,
    title: null,
    skip_permissions: false,
  });
  // Observation must work for stopped/archived terminals without an agent operation bridge.
  f.sessions.setStatus(watched.id, 'archived');
  const snapshot = withTrigger(f.options.snapshot, sessionHuddleTrigger, {
    worktree: f.home,
    kinds: ['terminal'],
    events: ['status'],
    statuses: ['running'],
    ...(selected ? { session: watched.id } : {}),
  });
  writeFileSync(join(f.root, 'huddle.json'), snapshot.files['huddle.json']!);
  writeFileSync(
    join(f.root, 'nodes/example/run.ts'),
    "import {HuddleNode} from 'puddlang/huddle'; export default HuddleNode({contract:'./node.json', async run({inputs}) { return {completed: inputs.value}; }});",
  );
  const feed = new HuddleSessionFeed(f.db);
  let dispatcher: HuddleSessionDispatcher | undefined;
  const startDispatcher = () => {
    dispatcher = new HuddleSessionDispatcher({ ...f, feed });
    dispatcher.start();
    return dispatcher;
  };
  const stopDispatcher = async () => {
    await dispatcher?.close();
    dispatcher = undefined;
  };
  return {
    ...f,
    watched,
    feed,
    startDispatcher,
    stopDispatcher,
    async close() {
      await stopDispatcher();
      await f.close();
    },
  };
}
