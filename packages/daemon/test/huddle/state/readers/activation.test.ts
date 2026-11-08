import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES, type HuddleOwnerState } from '@puddle/shared';
import { huddleLedgerFixture } from '../../../helpers/huddle/ledger.js';
import { readHuddleActivation } from '../../../../src/runtime/huddle/state/readers/activation.js';
import { readRetainedHuddleRevision } from '../../../../src/runtime/huddle/state/revisions.js';
function setup() {
  const f = huddleLedgerFixture();
  const applied = f.ledger.activations.apply(
    {
      id: randomUUID(),
      revision: 'a'.repeat(64),
      worktree: f.home,
      variables: { answer: 42 },
      bindings: {},
    },
    0,
  );
  const state: HuddleOwnerState = {
    format: 1,
    role: 'huddle',
    contract: 1,
    capabilities: HUDDLE_RUNTIME_CAPABILITIES,
    identity: {
      runtime_id: f.identity.runtimeId,
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: f.identity.profileId,
      project_id: f.identity.projectId,
      session_id: f.identity.sessionId,
      canonical_worktree_path: f.home,
    },
    scope: f.identity,
    build: 'fixture',
    lifetime: 'host_session',
    state: 'running',
    observation: 1,
    persistencePending: false,
    executing: false,
    commandCursor: 0,
    control: applied.control,
    liveWorkers: false,
    failure: null,
  };
  return {
    ...f,
    state,
    applied,
    file: join(f.home, 'runtimes', f.identity.runtimeId, 'huddle.sqlite'),
  };
}
it('reads a bounded WAL activation without obtaining the writer claim or changing ledger bytes', () => {
  const f = setup();
  try {
    const before = readFileSync(f.file + '-wal');
    expect(readHuddleActivation(f.home, f.state)).toEqual(f.applied.activation);
    expect(readFileSync(f.file + '-wal')).toEqual(before);
    expect(f.ledger.activations.current()).toEqual(f.applied.control);
    f.ledger.activations.setIntent(f.applied.control.generation, 'armed', false);
    expect(() => readHuddleActivation(f.home, f.state)).toThrow('changed');
  } finally {
    f.cleanup();
  }
});
it.each(['identity', 'version', 'oversized', 'missing'] as const)(
  'rejects %s evidence without repairing the private ledger',
  (mode) => {
    const f = setup();
    const db = new Database(f.file);
    try {
      if (mode === 'identity')
        db.prepare("UPDATE metadata SET value = '{}' WHERE key = 'identity'").run();
      if (mode === 'version') db.pragma('user_version = 2');
      if (mode === 'oversized')
        db.prepare("UPDATE records SET body = ? WHERE collection = 'revision-activations'").run(
          'x'.repeat(1048577),
        );
      if (mode === 'missing')
        db.prepare("DELETE FROM records WHERE collection = 'revision-activations'").run();
      const before = readFileSync(f.file + '-wal');
      expect(() => readHuddleActivation(f.home, f.state)).toThrow();
      expect(readFileSync(f.file + '-wal')).toEqual(before);
    } finally {
      db.close();
      f.cleanup();
    }
  },
);
it('does not create a missing retained-source directory', () => {
  const f = setup();
  try {
    const path = join(f.home, 'runtimes', f.identity.runtimeId);
    const before = readdirSync(path);
    expect(() =>
      readRetainedHuddleRevision(f.home, f.identity.runtimeId, f.identity.huddleId, 'a'.repeat(64)),
    ).toThrow();
    expect(readdirSync(path)).toEqual(before);
    expect(existsSync(join(path, 'huddle-revisions'))).toBe(false);
  } finally {
    f.cleanup();
  }
});
