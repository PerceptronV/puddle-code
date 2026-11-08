import { PROTOCOL_VERSION } from '@puddle/shared';
import { HuddleExecutionClient } from '../../../../cli/src/huddle/execution/client.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { huddleExecutionFixture } from '../../helpers/huddle/execution.js';
import { readoutSnapshot } from '../../helpers/huddle/readout.js';
import { until } from '../../helpers/huddle/controller.js';
import { RuntimeConnectionLost } from '../../../src/runtime/transport/client.js';

it.each([
  [false, false, false],
  [true, false, false],
  [true, true, false],
  [true, false, true],
])(
  'runs a project-local network readout and observes without retry (delivery reply lost=%s, observation reply lost=%s, retained=%s)',
  async (lost, lostObservationReply, retained) => {
    const received: Array<{ key: string; body: string }> = [];
    const observed: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        observed.push(String(request.headers['idempotency-key']));
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: 'destination-receipt' }));
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push({ key: String(request.headers['idempotency-key']), body });
      if (lost) return response.destroy();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'destination-receipt' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No receiver address');
    const f = await huddleExecutionFixture();
    try {
      const snapshot = readoutSnapshot(
        f.session.huddle_id!,
        `import {HuddleReadout} from 'puddlang/huddle';
      export default HuddleReadout({contract:'./node.json', async deliver(context, delivery) {
        try {
          const response = await fetch(delivery.inputs.value, {method:'POST',
            headers:{'idempotency-key':delivery.idempotencyKey}, body:JSON.stringify({node:delivery.node}), signal:context.signal});
          if (!response.ok) return {status:'failed',message:'Destination rejected delivery'};
          const receipt = await response.json();
          return {status:'delivered',receipt,outputs:{completed:receipt}};
        } catch { return {status:'unknown',message:'Destination reply was lost'}; }
      }, async observe(context, delivery) {
        const response = await fetch(delivery.inputs.value, {headers:{'idempotency-key':delivery.idempotencyKey}, signal:context.signal});
        const receipt = await response.json();
        return {status:'delivered',receipt,outputs:{completed:receipt}};
      }});`,
        { idempotent: false, reconciliation: 'observe', cancellation: 'signal' },
      );
      snapshot.components.worker!.capabilities = ['network'];
      snapshot.files['nodes/example/node.json'] = JSON.stringify(snapshot.components.worker);
      for (const [name, contents] of Object.entries(snapshot.files))
        writeFileSync(join(f.root, name), contents);
      const document = await f.source();
      expect(document.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
      const metadataPath = join(f.installed.release, 'RUNTIME_CAPABILITIES.json');
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      delete metadata.roles.huddle.readouts;
      delete metadata.roles.huddle.readoutObservation;
      writeFileSync(metadataPath, JSON.stringify(metadata));
      const refused = await f.request('start', { expected_digest: document.digest, variables: {} });
      expect(refused.body.error.code).toBe('huddle_execution_unsupported');
      expect(f.run).not.toHaveBeenCalled();
      metadata.roles.huddle.readouts = 1;
      if (lost) metadata.roles.huddle.readoutObservation = 1;
      writeFileSync(metadataPath, JSON.stringify(metadata));
      const started = await f.request('start', { expected_digest: document.digest, variables: {} });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const target = started.body.owner.target;
      expect(started.body.owner.readout_observation).toBeUndefined();
      expect((await f.request('runtime')).body.owner.readout_observation).toBeUndefined();
      expect(
        (await f.request('runtime?include_readout_observation=true')).body.owner
          .readout_observation,
      ).toBe(lost ? true : undefined);
      const run = await f.request('run', {
        target,
        node: 'run',
        event_id: randomUUID(),
        data: `http://127.0.0.1:${address.port}/`,
      });
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      const history = {
        owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
        collection: 'executions',
        after: 0,
      };
      await until(
        async () =>
          (await f.request('history', history)).body.records?.[0]?.record.state ===
          (lost ? 'failed' : 'completed'),
      );
      const execution = (await f.request('history', history)).body.records[0].record;
      const outcomes = await f.request('history', {
        ...history,
        collection: 'operations',
        parent: execution.id,
      });
      expect(outcomes.status).toBe(200);
      expect(outcomes.body.records[0].record).toMatchObject({
        kind: 'readout',
        state: lost ? 'unknown' : 'completed',
        consumed: true,
      });
      const operation = outcomes.body.records[0].record;
      const observation = { target, operation_id: operation.id };
      if (retained) {
        const request = { owner: history.owner, operation_id: operation.id };
        expect((await f.request('readouts/observe-retained', request)).status).toBe(409);
        expect(observed).toEqual([]);
        expect((await f.request('stop', { target })).status).toBe(200);
        rmSync(f.root, { recursive: true });
        const query = {
          ...history,
          collection: 'operations',
          parent: execution.id,
          include_readout_observation: true,
        };
        expect(
          (await f.request('history/retained', query)).body.history.records[0].record
            .readout_observation,
        ).toBe(true);
        const held = f.offlineReadouts.pause();
        expect((await f.request('readouts/observe-retained', request)).status).toBe(503);
        held.release();
        const cli = new HuddleExecutionClient(async (path, body) => {
          const response = await f.request(path.slice(`/sessions/${f.session.id}/`.length), body);
          if (response.status !== 200) throw new Error(JSON.stringify(response.body));
          return response.body;
        }, PROTOCOL_VERSION);
        const accepted = await cli.execute({
          action: 'observe-retained-readout',
          session_id: f.session.id,
          request,
        });
        expect(accepted).toEqual({ accepted: true, operation_id: operation.id });
        await until(
          async () =>
            (await f.request('history/retained', query)).body.history?.records[0]?.record.state ===
            'completed',
        );
        const result = (await f.request('history/retained', query)).body.history.records[0].record;
        expect(result.result).toMatchObject({
          status: 'delivered',
          receipt: { id: 'destination-receipt' },
        });
        expect(result.readout_observation).toBeUndefined();
        expect(
          (await f.request('history/retained', history)).body.history.records[0].record.state,
        ).toBe('failed');
        expect((await f.request('runtime')).body.owner).toBeNull();
        expect(f.run).toHaveBeenCalledTimes(1);
        expect((await f.request('readouts/observe-retained', request)).status).toBe(409);
        expect(observed).toEqual([received[0]!.key]);
      } else if (lost) {
        expect(operation.readout_observation).toBeUndefined();
        const eligible = await f.request('history', {
          ...history,
          collection: 'operations',
          parent: execution.id,
          include_readout_observation: true,
        });
        expect(eligible.body.records[0].record.readout_observation).toBe(true);
        const stale = await f.request('readouts/observe', {
          ...observation,
          target: { ...target, generation: target.generation + 1 },
        });
        expect(stale.status).toBe(409);
        expect(observed).toEqual([]);
        const missing = await f.request('readouts/observe', {
          ...observation,
          operation_id: randomUUID(),
        });
        expect(missing.status).toBe(409);
        expect(observed).toEqual([]);
        // Current files are not substituted for the captured adapter during reconciliation.
        writeFileSync(
          join(f.root, 'nodes/example/run.ts'),
          "throw new Error('Must not evaluate edited source');",
        );
        const client = f.connections.getHuddle(target.runtimeId)!;
        const request = client.request.bind(client);
        const calls = vi.spyOn(client, 'request').mockImplementation(async (command) => {
          const reply = await request(command);
          if (command.t === 'readout-observe' && lostObservationReply)
            throw new RuntimeConnectionLost();
          return reply;
        });
        const accepted = await f.request('readouts/observe', observation);
        if (lostObservationReply) expect(accepted.body.error.code).toBe('huddle_outcome_unknown');
        else
          expect(accepted, JSON.stringify(accepted)).toMatchObject({
            status: 200,
            body: { accepted: true, operation_id: operation.id },
          });
        await until(
          async () =>
            (
              await f.request('history', {
                ...history,
                collection: 'operations',
                parent: execution.id,
              })
            ).body.records?.[0]?.record.state === 'completed',
        );
        const settled = (
          await f.request('history', { ...history, collection: 'operations', parent: execution.id })
        ).body.records[0].record;
        expect(settled).toMatchObject({
          result: { status: 'delivered', receipt: { id: 'destination-receipt' } },
        });
        expect(settled.readout_observation).toBeUndefined();
        expect((await f.request('history', history)).body.records[0].record.state).toBe('failed');
        expect(observed).toEqual([received[0]!.key]);
        expect(
          calls.mock.calls.filter(([command]) => command.t === 'readout-observe'),
        ).toHaveLength(1);
        calls.mockRestore();
        const again = await f.request('readouts/observe', observation);
        expect(again.status).toBe(409);
      } else {
        const unsupported = await f.request('readouts/observe', observation);
        expect(unsupported.body.error.code).toBe('huddle_execution_unsupported');
        expect(observed).toEqual([]);
      }
      expect(received).toEqual([
        { key: expect.stringMatching(/^[a-f0-9]{64}$/), body: JSON.stringify({ node: 'worker' }) },
      ]);
      await f.request('runtime');
      await f.request('history', history);
      expect(received).toHaveLength(1);
      await f.request('stop', { target });
    } finally {
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
