import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { huddleContainmentSchema, runtimeSupervisorSchema } from '@puddle/shared';
import { readRuntimeJson, runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { huddleExecutionFixture } from '../../helpers/huddle/execution.js';
import { until } from '../../helpers/huddle/controller.js';
import { nativeJobs } from '../../helpers/update-continuity/native.js';

it.runIf(process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1')(
  'recovers a native huddle only after its detached descendant exits and its coalition is retired',
  async () => {
    const f = await huddleExecutionFixture(undefined, true);
    const jobs = nativeJobs(f.home);
    const source = `import { HuddleNode } from 'puddlang/huddle';
import fs from 'node:fs'; import { spawn } from 'node:child_process';
export default HuddleNode({contract:'./node.json', async run({inputs}) {
  if (inputs.value.kind !== 'spawn') return {completed:42};
  const root = inputs.value.root;
  fs.appendFileSync(root+'/entered','x');
  const code = "const fs=require('node:fs');const root=process.argv[1];fs.writeFileSync(root+'/detached',String(process.pid));const end=Date.now()+30000;const t=setInterval(()=>{if(fs.existsSync(root+'/release-child')||Date.now()>end){clearInterval(t);process.exit(0);}},20);";
  const child=spawn(process.execPath,['-e',code,root],{detached:true,stdio:'ignore'});child.unref();
  await new Promise(()=>{});
}});`;
    const registration = (id: string) => {
      const record = runtimeSupervisorSchema.parse(
        readRuntimeJson(join(runtimeDirectory(f.home, id), 'supervisor.json')),
      );
      if (record.kind !== 'launchd') throw new Error('Expected native test job');
      jobs.add({ kind: record.kind, name: record.name, domain: record.domain });
      return { kind: record.kind, name: record.name, domain: record.domain };
    };
    try {
      writeFileSync(join(f.root, 'nodes/example/run.ts'), source);
      const document = await f.source();
      const started = await f.request('start', { expected_digest: document.digest, variables: {} });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const target = started.body.owner.target;
      const service = registration(target.runtimeId);
      const ownerPid = await jobs.observe(service);
      expect(ownerPid).not.toBeNull();
      const record = huddleContainmentSchema.parse(
        readRuntimeJson(
          join(runtimeDirectory(f.home, target.runtimeId), 'huddle-containment.json'),
        ),
      );
      expect(record.kind).toBe('darwin-resource-coalition');
      const first = await f.request('run', {
        target,
        node: 'run',
        event_id: randomUUID(),
        data: { kind: 'spawn', root: f.home },
      });
      expect(first.status).toBe(200);
      await until(() => existsSync(join(f.home, 'detached')));
      const queued = await f.request('run', {
        target,
        node: 'run',
        event_id: randomUUID(),
        data: { kind: 'queued' },
      });
      expect(queued.status).toBe(200);
      process.kill(ownerPid!, 'SIGKILL'); // Only the freshly observed, uniquely named fixture job.
      await until(async () => await f.reconciler.retire(target.runtimeId));
      const recover = {
        owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
        after: 'owner-crash',
      };
      const blocked = await f.request('recover', recover);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.message).toContain('descendants');
      expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
      writeFileSync(join(f.home, 'release-child'), 'exit');
      if (record.kind !== 'darwin-resource-coalition') throw new Error('Expected coalition proof');
      await until(
        () =>
          JSON.parse(
            execFileSync(
              join(f.installed.release, 'daemon/huddle/darwin-containment'),
              ['observe', record.coalition],
              { encoding: 'utf8', timeout: 3000 },
            ),
          ).state !== 'populated',
      );
      const recovered = await f.request('recover', recover);
      expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
      const next = recovered.body.owner.target;
      registration(next.runtimeId);
      expect(next.runtimeId).not.toBe(target.runtimeId);
      const history = {
        owner: { runtimeId: next.runtimeId, incarnation: next.incarnation },
        collection: 'executions',
        after: 0,
      };
      await until(async () =>
        (await f.request('history', history)).body.records?.some(
          (row: { id: string; record: { id: string; state: string } }) =>
            row.record.id === queued.body.executionId && row.record.state === 'completed',
        ),
      );
      const records = (await f.request('history', history)).body.records;
      expect(
        records.find((row: { record: { id: string } }) => row.record.id === first.body.executionId)
          .record.state,
      ).toBe('interrupted');
      expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
      expect((await f.request('recover', recover)).status).toBe(409);
      expect((await f.request('stop', { target: next })).status).toBe(200);
    } finally {
      writeFileSync(join(f.home, 'release-child'), 'exit');
      for (const [command] of f.run.mock.calls) {
        if (command.args[0] !== 'bootstrap') continue;
        const supervisor = runtimeSupervisorSchema.parse(
          readRuntimeJson(join(dirname(command.args[2]!), 'supervisor.json')),
        );
        registration(supervisor.identity.runtime_id);
      }
      await jobs.cleanup();
      await f.close();
    }
  },
);
