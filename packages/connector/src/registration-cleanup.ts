import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connectorConfigSchema, type ConnectorConfig } from '@puddle/shared';
import { atomicPrivateJson, digest, privateDirectory, readPrivateJson } from '@puddle/shared/node';

const pendingDirectory = (directory: string) => join(directory, 'retired');

function pendingFiles(directory: string): string[] {
  const pending = pendingDirectory(directory);
  if (!existsSync(pending)) return [];
  privateDirectory(pending);
  return readdirSync(pending)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => join(pending, name));
}

export function hasRegistrationCleanup(directory: string): boolean {
  return pendingFiles(directory).length > 0;
}

/** Check before redeeming a replacement code, so a full queue cannot orphan a new credential. */
export function checkRetirementCapacity(directory: string, config: ConnectorConfig): string {
  const pending = pendingDirectory(directory);
  privateDirectory(pending);
  const key = digest(JSON.stringify([config.service, config.host, config.credential]));
  const path = join(pending, `${key}.json`);
  if (!existsSync(path) && pendingFiles(directory).length >= 32)
    throw new Error('Finish pending remote registration cleanup before removing another host.');
  return path;
}

/** Persist before removing/replacing config. Separate immutable files cannot clobber new work. */
export function retireRegistration(directory: string, config: ConnectorConfig): void {
  const path = checkRetirementCapacity(directory, config);
  atomicPrivateJson(path, { ...config, enabled: false });
}

/** Bounded best effort: local deletion always works when the relay is unavailable or older. */
export async function flushRegistrationCleanup(
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  await Promise.all(
    pendingFiles(directory)
      .slice(0, 32)
      .map(async (path) => {
        try {
          const config = connectorConfigSchema.parse(readPrivateJson(path));
          const timeout = AbortSignal.timeout(2000);
          const response = await fetch(`${config.service}/remote/unregister`, {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ credential: config.credential }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          await response.body?.cancel();
          // A legacy service's 404/403 is not an acknowledgement. Keep it for a later upgrade.
          if (response.status === 204 && !signal?.aborted) rmSync(path, { force: true });
        } catch {
          // Keep the private credential for an idempotent retry; never log it or re-enable access.
        }
      }),
  );
}

/** A supervisor can finish queued removals even after the last configuration has been deleted. */
export function startRegistrationCleanup(directory: string, stopWhenEmpty = false) {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running || controller.signal.aborted) return;
    running = flushRegistrationCleanup(directory, controller.signal)
      .then(() => {
        if (stopWhenEmpty && !hasRegistrationCleanup(directory)) clearInterval(timer);
      })
      .catch(() => {})
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, 30_000);
  tick();
  return {
    async close() {
      clearInterval(timer);
      controller.abort();
      await running;
    },
  };
}
