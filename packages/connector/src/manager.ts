import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectorConfigSchema } from '@puddle/shared';
import { ipcPath, listenPrivate, readPrivateJson } from '@puddle/shared/node';
import { startConnector } from './runtime.js';
import { profileDirectory, registeredProfiles } from './profile-state.js';
import { deleteRegistration } from './delete-registration.js';
import { startRegistrationCleanup } from './registration-cleanup.js';

/** One supervised process, independent runtimes and private stores for each profile. */
export async function startConnectorManager(home: string) {
  // Also excludes the old single-registration process before migration touches its files.
  const lock = await listenPrivate(ipcPath(home, 'remote'), (socket) => socket.destroy());
  const live = new Map<
    string,
    { fingerprint: string; runtime: Awaited<ReturnType<typeof startConnector>> }
  >();
  const cleanups = new Map<string, ReturnType<typeof startRegistrationCleanup>>();
  let stopped = false;
  let pending: Promise<void> | undefined;
  const reconcile = async () => {
    const legacy = join(home, 'remote');
    // Deliberate migration: no existing host-wide registration or approval is inherited.
    if (existsSync(join(legacy, 'config.json'))) {
      try {
        deleteRegistration(legacy);
      } catch {
        /* Never start legacy access; retry after queued retirements finish. */
      }
    }
    for (const directory of [
      legacy,
      ...registeredProfiles(home).map((id) => profileDirectory(home, id)),
    ]) {
      if (!cleanups.has(directory)) cleanups.set(directory, startRegistrationCleanup(directory));
    }
    const profiles = new Set(registeredProfiles(home));
    for (const profile of new Set([...profiles, ...live.keys()])) {
      if (stopped) return;
      const directory = profileDirectory(home, profile);
      const path = join(directory, 'config.json');
      let fingerprint = '';
      try {
        if (profiles.has(profile) && existsSync(path)) {
          const config = connectorConfigSchema.parse(readPrivateJson(path));
          const identity = join(directory, 'identity.json');
          fingerprint = JSON.stringify([
            config,
            existsSync(identity) ? readPrivateJson(identity) : null,
          ]);
        }
      } catch {
        /* Invalid or missing state closes this profile alone. */
      }
      const previous = live.get(profile);
      if (previous?.fingerprint === fingerprint) continue;
      if (previous) {
        await previous.runtime.close();
        live.delete(profile);
      }
      if (!fingerprint) continue;
      try {
        const runtime = await startConnector(home, profile);
        live.set(profile, { fingerprint: runtime.fingerprint, runtime });
      } catch {
        // Retry independently on the next poll. Never log private registration data.
      }
    }
  };
  const tick = () => {
    if (pending || stopped) return;
    pending = reconcile()
      .catch(() => {})
      .finally(() => {
        pending = undefined;
      });
  };
  try {
    await reconcile();
  } catch (error) {
    for (const { runtime } of live.values()) await runtime.close();
    for (const cleanup of cleanups.values()) await cleanup.close();
    await new Promise<void>((resolve) => lock.close(() => resolve()));
    throw error;
  }
  const timer = setInterval(tick, 500);
  return {
    async close() {
      stopped = true;
      clearInterval(timer);
      await pending;
      for (const { runtime } of live.values()) await runtime.close();
      for (const cleanup of cleanups.values()) await cleanup.close();
      await new Promise<void>((resolve) => lock.close(() => resolve()));
    },
  };
}
