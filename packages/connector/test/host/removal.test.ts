import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hostRemovalServicesSchema } from '@puddle/shared';
import {
  atomicPrivateJson,
  digest,
  ipcPath,
  listenPrivate,
  readPrivateJson,
} from '@puddle/shared/node';
import { continueRemovalDisable } from '../../src/host/removal.js';
import { disableAllProfiles, requireAllProfilesDisabled } from '../../src/host/disable.js';
import { profileMutation } from '../../src/mutation.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-disable-removal-')));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const release = join(home, 'bin/versions/0.4.0~abc123');
  mkdirSync(release, { recursive: true, mode: 0o700 });
  symlinkSync(release, join(home, 'bin/current'));
  const source = Buffer.from('fixture service').toString('base64');
  const record = hostRemovalServicesSchema.parse({
    format: 1,
    id: randomUUID(),
    release_path: release,
    services: [
      {
        source,
        review: {
          component: 'daemon',
          target: { kind: 'systemd', name: 'puddled.service', domain: null },
          process: null,
          definition: join(home, 'puddled.service'),
          sourceDigest: digest(source),
          definitionDigest: 'a'.repeat(64),
        },
      },
    ],
    actions: [
      { action: 'disable-remote', state: 'started' },
      { action: 'stop-daemon', state: 'planned' },
      { action: 'unregister-daemon', state: 'planned' },
    ],
  });
  const journal = join(home, 'installation/removal/services.json');
  atomicPrivateJson(journal, record);
  const config = {
    enabled: true,
    host: randomUUID(),
    account: 'fixture',
    credential: 'a'.repeat(64),
    service: 'https://relay.example.test',
    app: 'https://app.example.test',
  };
  const paths = [
    'remote',
    'remote/profiles/' + 'a'.repeat(10),
    'remote/profiles/' + 'b'.repeat(10),
  ].map((directory) => join(home, directory, 'config.json'));
  for (const path of paths) atomicPrivateJson(path, config);
  return { home, record, journal, config, paths };
}

it('continues partial disablement without rewriting or contacting already-disabled registrations', async () => {
  const f = fixture();
  writeFileSync(f.paths[2]!, '{');
  await expect(disableAllProfiles(f.home)).rejects.toThrow();
  const completed = f.paths
    .slice(0, 2)
    .map((path) => ({ path, bytes: readFileSync(path), inode: statSync(path).ino }));
  let requests = 0;
  const server = await listenPrivate(ipcPath(f.home, 'remote-' + 'a'.repeat(10)), (socket) => {
    requests++;
    socket.destroy();
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  atomicPrivateJson(f.paths[2]!, f.config);
  await continueRemovalDisable(f.home, f.record.id);
  requireAllProfilesDisabled(f.home);
  expect(requests).toBe(0);
  for (const { path, bytes, inode } of completed) {
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).ino).toBe(inode);
  }
  for (const path of f.paths)
    expect(readPrivateJson(path)).toEqual({ ...f.config, enabled: false });
  // The connector does not complete or otherwise modify the parent's removal journal.
  expect(readPrivateJson(f.journal)).toEqual(f.record);
  await continueRemovalDisable(f.home, f.record.id);
  expect(requests).toBe(0);
});

it.each(['id', 'missing', 'malformed', 'planned', 'finished', 'release'])(
  'rejects %s removal evidence before disabling a profile',
  async (change) => {
    const f = fixture();
    if (change === 'missing') unlinkSync(f.journal);
    if (change === 'malformed') writeFileSync(f.journal, '{');
    if (change === 'planned' || change === 'finished') {
      f.record.actions[0]!.state = change;
      atomicPrivateJson(f.journal, f.record);
    }
    if (change === 'release') {
      unlinkSync(join(f.home, 'bin/current'));
      symlinkSync(f.home, join(f.home, 'bin/current'));
    }
    const before = f.paths.map((path) => readFileSync(path));
    await expect(
      continueRemovalDisable(f.home, change === 'id' ? randomUUID() : f.record.id),
    ).rejects.toThrow();
    expect(f.paths.map((path) => readFileSync(path))).toEqual(before);
  },
);

it('uses the existing profile writer lock and can continue after that writer leaves', async () => {
  const f = fixture();
  await profileMutation(f.home, 'a'.repeat(10), async () => {
    await expect(continueRemovalDisable(f.home, f.record.id)).rejects.toThrow();
    expect(readPrivateJson(f.paths[1]!)).toEqual(f.config);
  });
  await continueRemovalDisable(f.home, f.record.id);
  requireAllProfilesDisabled(f.home);
});

it('rechecks removal evidence after a live request loses its reply before any offline write', async () => {
  const f = fixture();
  const server = await listenPrivate(ipcPath(f.home, 'remote-' + 'a'.repeat(10)), (socket) => {
    socket.once('data', () => {
      unlinkSync(f.journal);
      socket.destroy();
    });
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await expect(continueRemovalDisable(f.home, f.record.id)).rejects.toThrow('exact active removal');
  expect(readPrivateJson(f.paths[1]!)).toEqual(f.config);
  expect(readPrivateJson(f.paths[2]!)).toEqual(f.config);
});

it('observes a lost live disable reply without rewriting its already-persisted result', async () => {
  const f = fixture();
  let completedInode: number | undefined;
  let requests = 0;
  const server = await listenPrivate(ipcPath(f.home, 'remote-' + 'a'.repeat(10)), (socket) => {
    socket.once('data', () => {
      requests++;
      atomicPrivateJson(f.paths[1]!, { ...f.config, enabled: false }, { syncDirectory: true });
      completedInode = statSync(f.paths[1]!).ino;
      socket.destroy();
    });
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await continueRemovalDisable(f.home, f.record.id);
  requireAllProfilesDisabled(f.home);
  expect(requests).toBe(1);
  expect(statSync(f.paths[1]!).ino).toBe(completedInode);
  await continueRemovalDisable(f.home, f.record.id);
  expect(requests).toBe(1);
});
