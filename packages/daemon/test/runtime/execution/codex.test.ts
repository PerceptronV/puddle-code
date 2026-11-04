import { placement } from '../../helpers/runtime-placement.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { HostMemoryLedger } from '../../../src/runtime/resources/host/ledger.js';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireRuntimeController } from '../../../src/runtime/ownership/storage.js';
import {
  bundleDir,
  clients,
  controllers,
  launchOwner,
  prepare,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';

describe('runtime-owned Codex adapter', () => {
  it('keeps its real proxy, PTY and fake app-server through shared pressure and controller replacement', async () => {
    const { home, launch, directory, controller } = prepare('interactive');
    const bin = join(home, 'bin');
    mkdirSync(bin, { mode: 0o700 });
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    writeFileSync(
      join(bin, 'codex'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bundleDir, 'fake-codex.mjs'))} "$@"\n`,
      { mode: 0o700 },
    );
    const path = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
    launch.provider!.id = 'codex';
    launch.main.env['PATH'] = path;
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const owner = launchOwner(home, launch.identity.runtime_id, 'puddler.mjs', path);
    await waitForOwner(owner, directory);
    const client = await RuntimeClient.open(home, launch, controller.record);
    clients.push(client);
    const term = terminal(client.state);
    await waitForSnapshot(client, term.generation, 'bound:native-codex-fixture');
    const input = {
      placement: placement(client),
      t: 'input' as const,
      term: 'agent',
      generation: term.generation,
      source: 'human' as const,
      data: 'tick\n',
    };
    await client.request(input);
    await waitForSnapshot(client, term.generation, 'count:1');
    const pid = client.state!.agent!.sidecar_pids[0]!;
    const ledger = HostMemoryLedger.openExisting(home)!;
    const pressure = {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
    };
    let pressureRevision: number | null = null;
    try {
      // Dispatch input before occupying host capacity; only its native reply is gated.
      await client.request({ ...input, data: 'burst\n' });
      await vi.waitFor(() =>
        expect(readFileSync(join(home, '.fake-codex-burst'), 'utf8')).toBe('1'),
      );
      await vi.waitFor(
        () => expect(ledger.readGrant(launch.identity)!.bytes).toBeLessThan(48 * 1024 * 1024),
        { timeout: 10000 },
      );
      await vi.waitFor(() => {
        const own = ledger.readGrant(launch.identity)!;
        const grant = ledger.compareGrant(pressure, 0, ledger.capacityBytes - own.bytes);
        expect(grant).not.toBeNull();
        pressureRevision = grant!.revision;
      });
      writeFileSync(join(home, '.fake-codex-release-burst'), 'release');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(join(home, '.fake-codex-received'))).toBe(false);
      expect(owner.child.exitCode).toBeNull();
      expect(() => process.kill(term.pid!, 0)).not.toThrow();
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(ledger.compareGrant(pressure, pressureRevision!, 0)).not.toBeNull();
      pressureRevision = null;
      await vi.waitFor(
        () => expect(readFileSync(join(home, '.fake-codex-received'), 'utf8')).toBe('1'),
        { timeout: 5000 },
      );
      await waitForSnapshot(client, term.generation, 'burst:1 bytes:2097152');
      expect(readFileSync(join(home, '.fake-codex-burst'), 'utf8')).toBe('1');
      expect(terminal(client.state).pid).toBe(term.pid);
    } finally {
      if (pressureRevision !== null) ledger.compareGrant(pressure, pressureRevision, 0);
      ledger.close();
    }
    // More than the metadata domain's 1024 concurrent entries must be processed
    // on one native connection without retaining completed request inspections.
    await client.request({ ...input, data: 'many\n' });
    await waitForSnapshot(client, term.generation, 'count:1101');
    client.close();
    controller.release();
    const replacement = acquireRuntimeController(home);
    controllers.push(replacement);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    expect(terminal(next.state).pid).toBe(term.pid);
    expect(next.state!.agent).toMatchObject({
      native_sync: 'full',
      sidecar_pids: [pid],
      agent_session_ref: 'native-codex-fixture',
    });
    await next.request(input);
    await waitForSnapshot(next, term.generation, `count:1102 sidecar:${pid}`);
    const exited = once(owner.child, 'exit');
    await next.request({ placement: placement(next), t: 'stop' });
    await exited;
    // The fixture ignores SIGTERM, so this also proves disposal waits for its
    // bounded SIGKILL fallback before the owner releases its lifetime claim.
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
