import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { HostControlClient } from '@puddle/shared/node/host-control';
import type { WsServerMessage } from '@puddle/shared';
import { once } from 'node:events';
import WebSocket from 'ws';
import { runCompilationCommand } from '../../../src/compilation/process.js';
import { serviceIsStopped } from '../../../src/host/supervision/stopped.js';
import { inspectLaunchdProcess } from '../../../src/host/supervision/launchd.js';
import type { ServiceTarget } from '../../../src/host/supervision/target.js';
import { environment, retainRuntimeHome } from '../runtime-fixture.js';

export async function nativeWait(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(25);
  }
}

/** Only uniquely named test jobs and owners discovered under this temporary home. */
export function nativeJobs(home: string) {
  const targets = new Map<
    string,
    { target: ServiceTarget; pids: Set<number>; groups: Set<number> }
  >();
  const run: typeof runCompilationCommand = (command) =>
    runCompilationCommand({ ...command, env: environment(home) });
  const execute = (args: string[]) =>
    run({ file: '/bin/launchctl', args, cwd: home, timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
  const add = (target: ServiceTarget) => {
    if (target.kind !== 'launchd' || !target.name.startsWith('dev.puddle.'))
      throw new Error('Unexpected native test target');
    if (target.name === 'dev.puddle.puddled' || target.name === 'dev.puddle.connector')
      throw new Error('Installed services are forbidden in this fixture');
    if (!targets.has(target.name))
      targets.set(target.name, { target, pids: new Set(), groups: new Set() });
  };
  const observe = async (target: ServiceTarget) => {
    add(target);
    const pid = await inspectLaunchdProcess(home, target, run);
    if (pid) targets.get(target.name)!.pids.add(pid);
    return pid;
  };
  return {
    run,
    execute,
    add,
    observe,
    remember(target: ServiceTarget, pid: number) {
      add(target);
      targets.get(target.name)!.pids.add(pid);
    },
    rememberGroup(target: ServiceTarget, group: number) {
      add(target);
      targets.get(target.name)!.pids.add(group);
      targets.get(target.name)!.groups.add(group);
    },
    async cleanup() {
      try {
        const ordered = [...targets.values()].sort(
          (a, b) =>
            Number(b.target.name.startsWith('dev.puddle.test.update.')) -
            Number(a.target.name.startsWith('dev.puddle.test.update.')),
        );
        for (const { target, pids, groups } of ordered) {
          if (!(await serviceIsStopped(home, target, run))) {
            const pid = await observe(target);
            if (pid) pids.add(pid);
            await execute(['bootout', `${target.domain}/${target.name}`]);
          }
          await nativeWait(
            () => serviceIsStopped(home, target, run),
            `Job removal unconfirmed: ${target.name}`,
          );
          for (const pid of pids)
            await nativeWait(() => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
                throw error;
              }
            }, `Process exit unconfirmed: ${target.name}`);
          for (const group of groups)
            await nativeWait(() => {
              try {
                process.kill(-group, 0);
                return false;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
                throw error;
              }
            }, `Process group exit unconfirmed: ${target.name}`);
        }
      } catch (error) {
        retainRuntimeHome(home);
        throw new Error(`Native upgrade cleanup is unconfirmed; retained ${home}`, {
          cause: error,
        });
      }
    },
  };
}

/** Normal cockpit terminal traffic, without competing with daemon runtime control. */
export async function nativeViewer(
  control: HostControlClient,
  session: string,
  sockets: WebSocket[],
) {
  const ws = new WebSocket(`ws://127.0.0.1:${control.port}/ws`);
  sockets.push(ws);
  const messages: WsServerMessage[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as WsServerMessage));
  await once(ws, 'open');
  const resource = control.resource(() => ws.terminate());
  ws.once('close', () => resource.release());
  const send = (message: object) => ws.send(JSON.stringify(message));
  send({ t: 'auth', token: control.credential(), resource: resource.id });
  await nativeWait(
    () => messages.some((message) => message.t === 'authenticated'),
    'Native viewer authentication failed',
  );
  send({ t: 'attach', session, term: 'agent', cols: 90, rows: 25 });
  await nativeWait(
    () => messages.some((message) => message.t === 'replay'),
    'Native viewer replay failed',
  );
  return {
    input: (data: string) => send({ t: 'stdin', session, term: 'agent', data }),
    text: () =>
      messages
        .flatMap((message) =>
          message.t === 'output' || message.t === 'replay' ? [message.data] : [],
        )
        .join(''),
  };
}

export const nativeJobLog = (home: string, name: string) => join(home, `${name}.log`);
