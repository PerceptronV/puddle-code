import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { huddleExecutionFixture } from '../../../helpers/huddle/execution.js';
import {
  customTriggerSnapshot,
  fileTriggerSource,
} from '../../../helpers/huddle/custom-trigger.js';
import { until } from '../../../helpers/huddle/controller.js';

it('gates old runtimes, survives controller disconnection and resumes the declared cursor through HTTP lifecycle', async () => {
  const f = await huddleExecutionFixture();
  try {
    const snapshot = customTriggerSnapshot(f.session.huddle_id!, fileTriggerSource, f.home);
    for (const [name, value] of Object.entries(snapshot.files))
      writeFileSync(join(f.root, name), value);
    const document = await f.source();
    expect(document.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    const metadataPath = join(f.installed.release, 'RUNTIME_CAPABILITIES.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    delete metadata.roles.huddle.customTriggers;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    expect(
      (await f.request('start', { expected_digest: document.digest, variables: {} })).body.error
        .code,
    ).toBe('huddle_execution_unsupported');
    expect(f.run).not.toHaveBeenCalled();
    metadata.roles.huddle.customTriggers = 1;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const started = await f.request('start', { expected_digest: document.digest, variables: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.owner.custom_triggers).toBeUndefined();
    const target = started.body.owner.target;
    const state = () => f.request('runtime?include_custom_triggers=true');
    await until(
      async () => (await state()).body.owner?.custom_triggers?.[0]?.health.state === 'ready',
    );
    expect((await f.request('runtime')).body.owner.custom_triggers).toBeUndefined();
    const history = {
      owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
      collection: 'executions',
      after: 0,
    };
    writeFileSync(join(f.home, 'input.json'), JSON.stringify({ id: 'one', value: 42 }));
    await until(
      async () =>
        (await f.request('history', history)).body.records?.[0]?.record.state === 'completed',
    );
    let firstSequence = 0;
    await until(() => {
      try {
        firstSequence = JSON.parse(readFileSync(join(f.home, 'ack'), 'utf8')).sequence;
        return firstSequence > 0;
      } catch {
        return false;
      }
    });
    // No controller call or frontend is needed to observe or execute the second event.
    f.connections.getHuddle(target.runtimeId)!.close();
    writeFileSync(join(f.home, 'input.json'), JSON.stringify({ id: 'two', value: 43 }));
    await until(() => {
      try {
        return (
          JSON.parse(readFileSync(join(f.home, 'ack'), 'utf8')).sequence > firstSequence &&
          readFileSync(join(f.home, 'opened'), 'utf8').trim() === 'null'
        );
      } catch {
        return false;
      }
    });
    await until(async () => {
      await f.connections.connectOwner(target.runtimeId);
      return !!f.connections.getHuddle(target.runtimeId);
    });
    await until(
      async () =>
        (await f.request('history', history)).body.records?.filter(
          (item: { record: { state: string } }) => item.record.state === 'completed',
        ).length === 2,
    );
    const before = (await state()).body.owner.target;
    const interrupted = await f.request('interrupt', { target: before });
    expect(interrupted.status).toBe(200);
    expect((await state()).body.owner.custom_triggers[0].health.state).toBe('closed');
    expect(readFileSync(join(f.home, 'closed'), 'utf8')).toBe('x');
    writeFileSync(join(f.home, 'input.json'), JSON.stringify({ id: 'three', value: 44 }));
    expect((await f.request('history', history)).body.records).toHaveLength(2);
    const resumed = await f.request('rearm', { target: interrupted.body.owner.target });
    expect(resumed.status).toBe(200);
    await until(async () => (await f.request('history', history)).body.records?.length === 3);
    expect(readFileSync(join(f.home, 'opened'), 'utf8').trim().split('\n')).toEqual([
      'null',
      '"two"',
    ]);
    expect((await f.request('stop', { target: resumed.body.owner.target })).status).toBe(200);
    expect(readFileSync(join(f.home, 'closed'), 'utf8')).toBe('xx');
  } finally {
    await f.close();
  }
});
