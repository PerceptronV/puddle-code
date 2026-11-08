import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { huddleExecutionFixture } from '../../helpers/huddle/execution.js';
import { readoutSnapshot } from '../../helpers/huddle/readout.js';
import { until } from '../../helpers/huddle/controller.js';

it.each([false, true])(
  'runs a project-local network readout and preserves a lost receipt without retry (lost=%s)',
  async (lost) => {
    const received: Array<{ key: string; body: string }> = [];
    const server = createServer(async (request, response) => {
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
      }});`,
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
      writeFileSync(metadataPath, JSON.stringify(metadata));
      const refused = await f.request('start', { expected_digest: document.digest, variables: {} });
      expect(refused.body.error.code).toBe('huddle_execution_unsupported');
      expect(f.run).not.toHaveBeenCalled();
      metadata.roles.huddle.readouts = 1;
      writeFileSync(metadataPath, JSON.stringify(metadata));
      const started = await f.request('start', { expected_digest: document.digest, variables: {} });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const target = started.body.owner.target;
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
