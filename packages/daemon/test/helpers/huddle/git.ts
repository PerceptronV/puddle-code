import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { gitHuddleTrigger, type HuddleJson } from '@puddle/shared';
import { huddleLedgerFixture } from './ledger.js';
import { schedulerSnapshot } from './scheduler.js';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';
import { withTrigger } from './trigger.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { gitDefinitions } from '../../../src/runtime/huddle/triggers/git/definitions.js';
import { readGit } from '../../../src/runtime/huddle/triggers/git/read.js';

export async function gitFixture(parameters: Record<string, HuddleJson> = {}, linked = false) {
  const base = huddleLedgerFixture(),
    worktree = join(realpathSync(base.home), 'worktree');
  try {
    mkdirSync(worktree);
    const command = (args: string[], cwd = worktree) =>
      readGit(
        cwd,
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'tag.gpgsign=false',
          ...args,
        ],
        new AbortController().signal,
      );
    await command(['init', '--initial-branch=main']);
    const snapshot = withTrigger(schedulerSnapshot(base.identity.huddleId, ''), gitHuddleTrigger, {
      worktree,
      ...parameters,
    });
    const bindings: Record<string, { worktree: string }> = { run: { worktree } };
    if (linked) {
      await command(['commit', '--allow-empty', '-m', 'baseline']);
      const path = join(realpathSync(base.home), 'linked');
      await command(['worktree', 'add', '-b', 'linked', path]);
      snapshot.definition.nodes.push({
        ...snapshot.definition.nodes[0]!,
        id: 'linked',
        parameters: {
          ...snapshot.definition.nodes[0]!.parameters,
          worktree: { kind: 'literal', value: path },
        },
      });
      snapshot.components.linked = gitHuddleTrigger;
      snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
      snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
      bindings.linked = { worktree: path };
    }
    const store = new HuddleRevisionStore(
      base.home,
      base.identity.runtimeId,
      base.identity.huddleId,
    );
    const revisions = new HuddleRevisionController(base.ledger, store);
    const { activation } = revisions.apply(
      snapshot,
      { id: randomUUID(), worktree: realpathSync(base.home), variables: {}, bindings },
      0,
    );
    base.ledger.activations.setIntent(1, 'armed', false);
    const definition = gitDefinitions(snapshot, activation)[0]!;
    return { ...base, base, worktree, snapshot, store, revisions, activation, definition, command };
  } catch (error) {
    base.cleanup();
    throw error;
  }
}
