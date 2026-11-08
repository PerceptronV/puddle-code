import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { huddleDefinitionSchema } from '@puddle/shared';
import { captureHuddleDefinition } from '../../../src/huddle/definitions/capture.js';
import { prepareHuddleWorkerJob } from '../../../src/huddle/definitions/worker.js';
import {
  fixtureBuiltins,
  manualComponent,
  resultComponent,
} from '../../../../shared/test/helpers/huddle.js';
import { huddleLedgerFixture, type HuddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { invocations } from '../../helpers/huddle/graph.js';
import { workerJob, workerTestHarness } from '../../helpers/huddle/worker.js';

const workers = workerTestHarness();
const fixtures: HuddleLedgerFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('captured script execution through the durable graph', () => {
  it('executes the captured source after worktree edits and records acknowledged outputs exactly once', async () => {
    const f = huddleLedgerFixture();
    fixtures.push(f);
    const worktree = join(f.home, 'project');
    const root = join(worktree, '.puddle/huddle', f.identity.huddleId);
    await mkdir(join(root, 'nodes/example'), { recursive: true });
    const sample = workerJob(`\uFEFFimport {HuddleNode} from 'puddlang/huddle';
      import {double} from './helper.ts';
      export default HuddleNode({contract:'./node.json', async run({inputs,emit}) {
        await emit('turn', inputs.value);
        return {completed:double(inputs.value)};
      }});`);
    sample.component.dependencies = ['./helper.ts'];
    sample.files['nodes/example/node.json'] = JSON.stringify(sample.component);
    sample.files['nodes/example/helper.ts'] = 'export const double = (n: number) => n * 2;';
    const definition = huddleDefinitionSchema.parse({
      format: 1,
      id: f.identity.huddleId,
      name: 'Captured calculation',
      nodes: [
        { id: 'run', source: { kind: 'builtin', component: manualComponent.id, version: 1 } },
        { id: 'worker', source: { kind: 'local', manifest: './nodes/example/node.json' } },
        { id: 'result', source: { kind: 'builtin', component: resultComponent.id, version: 1 } },
      ],
      edges: [
        {
          id: 'start',
          from: { node: 'run', port: 'event' },
          to: { node: 'worker', port: 'value' },
        },
        {
          id: 'result',
          from: { node: 'worker', port: 'completed' },
          to: { node: 'result', port: 'value' },
        },
      ],
    });
    await writeFile(join(root, 'huddle.json'), JSON.stringify(definition));
    for (const [path, content] of Object.entries(sample.files))
      await writeFile(join(root, path), content);
    const snapshot = await captureHuddleDefinition(worktree, definition.id, fixtureBuiltins);
    const event = f.event({ revision: snapshot.digest, data: 21 });
    f.ledger.executions.accept(event, null, 1, definition.execution);
    const graph = f.ledger.graph(
      snapshot.digest,
      definition,
      new Map(Object.entries(snapshot.components)),
    );
    graph.start(event.executionId);
    const invocation = invocations(f, event.executionId, 'worker')[0]!;
    const job = prepareHuddleWorkerJob(snapshot, invocation, {}, {});
    expect(() =>
      prepareHuddleWorkerJob(
        {
          ...snapshot,
          files: {
            ...snapshot.files,
            'nodes/example/helper.ts': 'export const double = () => 99;',
          },
        },
        invocation,
        {},
        {},
      ),
    ).toThrow('exact validated');
    expect(() =>
      prepareHuddleWorkerJob(
        { ...snapshot, definition: { ...snapshot.definition, name: 'Changed settings' } },
        invocation,
        {},
        {},
      ),
    ).toThrow('settings differ');
    expect(() =>
      prepareHuddleWorkerJob({ ...snapshot, digest: 'b'.repeat(64) }, invocation, {}, {}),
    ).toThrow('exact validated');
    await writeFile(
      join(root, 'nodes/example/helper.ts'),
      'throw new Error("new draft must not run");',
    );
    f.ledger.invocations.start(invocation.id);
    const worker = workers.start(job, {
      cwd: worktree,
      request: async ({ action }) => {
        if (action.kind !== 'emit') throw new Error('No external operations in calculation');
        f.ledger.invocations.emit(invocation.id, action.sequence, action.port, action.value);
        return null;
      },
    });
    const outputs = await worker.result;
    expect(outputs).toEqual({ completed: 42 });
    f.ledger.invocations.complete(invocation.id, outputs);
    expect(graph.route(invocation.id, 1)).toBe(true);
    expect(graph.route(invocation.id, 2)).toBe(true);
    expect(graph.route(invocation.id, 2)).toBe(false);
    f.reopen();
    expect(f.ledger.invocations.get(invocation.id).result).toEqual({ completed: 42 });
    expect(invocations(f, event.executionId, 'result').map((record) => record.inputs)).toEqual([
      { value: 42 },
    ]);
  });
});
