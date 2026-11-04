import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { watchInstalledReleases } from '../../src/features/release-notes/state/installed';
import { statusFixture, reviewFixture } from '../host-updates/fixtures';

it('refreshes installed notes when the existing remote poll observes a runtime-only change', () => {
  const client = new QueryClient();
  const notes = ['release-notes', 'remote-host'];
  const updates = ['cockpit-host-updates', 'remote-host'];
  const stop = watchInstalledReleases(client, 'remote-host');
  try {
    client.setQueryData(notes, { releases: [] });
    client.setQueryData(updates, statusFixture());
    expect(client.getQueryState(notes)?.isInvalidated).toBe(true);
    client.setQueryData(notes, { releases: [] });
    client.setQueryData(updates, statusFixture());
    expect(client.getQueryState(notes)?.isInvalidated).toBe(false);

    const changed = statusFixture();
    changed.catalogue!.runtime_default!.version = '0.4.2';
    client.setQueryData(updates, changed);
    expect(client.getQueryState(notes)?.isInvalidated).toBe(true);
  } finally {
    stop();
    client.clear();
  }
});

it('ignores staged targets, recorded status and another host, and unsubscribes cleanly', () => {
  const client = new QueryClient();
  const notes = ['release-notes', 'host'];
  const updates = ['cockpit-host-updates', 'host'];
  client.setQueryData(updates, statusFixture());
  const stop = watchInstalledReleases(client, 'host');
  try {
    client.setQueryData(notes, { releases: [] });
    const staged = statusFixture();
    staged.result = reviewFixture();
    staged.result.operation!.targets = [{ component: 'runtime', version: '0.9.0' }];
    client.setQueryData(updates, staged);
    const recorded = statusFixture();
    recorded.observation = 'recorded';
    recorded.catalogue!.daemon_version = '0.9.0';
    client.setQueryData(updates, recorded);
    client.setQueryData(['cockpit-host-updates', 'another-host'], statusFixture());
    expect(client.getQueryState(notes)?.isInvalidated).toBe(false);
    stop();
    client.setQueryData(updates, { ...recorded, observation: 'live' });
    expect(client.getQueryState(notes)?.isInvalidated).toBe(false);
  } finally {
    stop();
    client.clear();
  }
});
