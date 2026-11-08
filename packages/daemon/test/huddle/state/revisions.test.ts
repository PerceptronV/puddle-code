import { readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';
import { restoreHuddleDefinition } from '../../../src/huddle/definitions/restore.js';
import { huddleLedgerFixture, type HuddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { revisionFixture } from '../../helpers/huddle/revisions.js';

const fixtures: HuddleLedgerFixture[] = [];
function setup(limits?: ConstructorParameters<typeof HuddleRevisionStore>[3]) {
  const f = huddleLedgerFixture();
  fixtures.push(f);
  const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId, limits);
  const snapshot = revisionFixture(f);
  const file = join(
    f.home,
    'runtimes',
    f.identity.runtimeId,
    'huddle-revisions',
    `${snapshot.digest}.json`,
  );
  return { f, store, snapshot, file };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('immutable huddle source publication', () => {
  it('publishes complete source without activating it and reopens the same content', () => {
    const { f, store, snapshot, file } = setup();
    store.publish(snapshot);
    const bytes = readFileSync(file);
    expect(store.publish(snapshot).digest).toBe(snapshot.digest);
    expect(readFileSync(file)).toEqual(bytes);
    expect(f.ledger.activations.current().activationId).toBeNull();
    expect(
      new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId).read(
        snapshot.digest,
      ).definition,
    ).toEqual(snapshot.definition);
  });

  it('rejects corrupted or symlinked retained source without repairing it in place', () => {
    const { store, snapshot, file } = setup();
    store.publish(snapshot);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    document.files['huddle.json'] = document.files['huddle.json'].replace(
      'Retained huddle',
      'Changed source',
    );
    writeFileSync(file, JSON.stringify(document));
    const corrupted = readFileSync(file);
    expect(() => store.read(snapshot.digest)).toThrow('digest');
    expect(() => store.publish(snapshot)).toThrow('digest');
    expect(readFileSync(file)).toEqual(corrupted);
    unlinkSync(file);
    symlinkSync('/dev/null', file);
    expect(() => store.read(snapshot.digest)).toThrow('private');
  });

  it('enforces retained counts/bytes while preserving existing revisions', () => {
    const { f, store, snapshot } = setup({ records: 1 });
    store.publish(snapshot);
    expect(() => store.publish(revisionFixture(f, 'Next'))).toThrow('count');
    expect(store.read(snapshot.digest).definition.name).toBe('Retained huddle');
    const bounded = setup({ retainedBytes: 1 });
    expect(() => bounded.store.publish(bounded.snapshot)).toThrow('bytes');
    expect(() => bounded.store.read(bounded.snapshot.digest)).toThrow();
  });

  it('restores metadata without loading code and rejects missing or extra captured dependencies', () => {
    const { f, store, snapshot } = setup();
    snapshot.definition.nodes[1]!.source = { kind: 'local', manifest: './nodes/result/node.json' };
    snapshot.components['result'] = {
      ...snapshot.components['result']!,
      entry: './run.ts',
      readout: { idempotent: false, reconciliation: 'none', cancellation: 'none' },
    };
    snapshot.files = {
      'huddle.json': JSON.stringify(snapshot.definition),
      'nodes/result/node.json': JSON.stringify(snapshot.components['result']),
      'nodes/result/run.ts': 'throw new Error("must never execute while restoring");',
    };
    snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
    expect(store.publish(snapshot).definition.id).toBe(f.identity.huddleId);
    const files = { ...snapshot.files, 'extra.ts': 'export default 1;' };
    expect(() =>
      restoreHuddleDefinition(
        {
          format: 1,
          digest: huddleRevisionDigest(files, snapshot.components),
          files,
          components: snapshot.components,
        },
        f.identity.huddleId,
      ),
    ).toThrow('declared graph closure');
    delete snapshot.files['nodes/result/run.ts'];
    snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
    expect(() => store.publish(snapshot)).toThrow('dependency is missing');
  });

  it('rejects another huddle id and unsafe or unsupported persisted document shapes', () => {
    const { f, store, snapshot } = setup();
    snapshot.definition.id = 'f'.repeat(32);
    snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
    snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
    expect(() => store.publish(snapshot)).toThrow('another huddle');
    expect(() => store.read('../escape')).toThrow();
    expect(() => restoreHuddleDefinition({ format: 2 }, f.identity.huddleId)).toThrow();
  });
});
