import { placement } from '../../helpers/runtime-placement.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeCheckpointSchema, runtimeStateSchema } from '@puddle/shared';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import {
  acquireRuntimeControllerWhenAvailable,
  readRuntimeJson,
} from '../../../src/runtime/ownership/storage.js';
import {
  clients,
  controllers,
  setup,
  terminal,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Segment fixture did not reach its boundary');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function snapshot(client: RuntimeClient, term: string, generation: string, expected: string) {
  const deadline = Date.now() + 10_000;
  while (true) {
    const result = await client.request({ t: 'snapshot', term, generation });
    if (result.t === 'snapshot' && result.data.includes(expected)) return result;
    if (Date.now() >= deadline) throw new Error('Missing terminal fixture output');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
describe('native lifecycle history continuity', () => {
  it('retains ordered segments and frozen screens across multiple native switches with the controller absent', async () => {
    const { home, launch, controller, client, owner, directory } = await setup('interactive');
    const signal = readRuntimeJson(join(home, `${launch.identity.session_id}.signals.json`)) as {
      url: string;
      nonce: string;
    };
    const lifecycle = async (ref: string, source: 'startup' | 'clear' | 'fork') => {
      const response = await fetch(signal.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nonce: signal.nonce,
          event: 'session_start',
          agent_session_ref: ref,
          cwd: home,
          source,
        }),
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(204);
      return runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json'))).history
        .current;
    };
    const first = await lifecycle('native-first', 'startup');
    const main = terminal(client.state);
    await client.request({
      placement: placement(client),
      t: 'spawn-shell',
      term: 'shell-1',
      command: launch.main,
    });
    await client.request({ t: 'inspect' });
    const shell = client.state!.terminals.find((term) => term.term === 'shell-1')!;
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'shell-1',
      generation: shell.generation,
      source: 'human',
      data: "stty -echo; extra=retained; printf 'extra-%s\\n' ready\n",
    });
    await snapshot(client, 'shell-1', shell.generation, 'extra-ready');
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: "stty -echo; mainState=retained; printf 'echo-%s\\n' disabled\n",
    });
    await waitForSnapshot(client, main.generation, 'echo-disabled');
    const gateOne = join(home, 'second-gate'),
      gateTwo = join(home, 'third-gate');
    const script = join(home, 'segmented-output.sh');
    writeFileSync(
      script,
      [
        "printf '\\033[?1002h\\033[?1006hsegment-first\\n'",
        `while [ ! -f ${quote(gateOne)} ]; do sleep 0.02; done`,
        "printf 'segment-second\\n'",
        `while [ ! -f ${quote(gateTwo)} ]; do sleep 0.02; done`,
        "printf 'segment-third\\n'",
      ].join('\n'),
      { mode: 0o600 },
    );
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: `/bin/sh ${quote(script)}\n`,
    });
    await waitForSnapshot(client, main.generation, 'segment-first');
    client.close();
    controller.release();

    const second = await lifecycle('native-second', 'clear');
    writeFileSync(gateOne, 'go');
    await until(() => {
      try {
        return readFileSync(
          join(directory, 'logs', second.id, `agent.${main.generation}.log`),
          'utf8',
        ).includes('segment-second');
      } catch {
        return false;
      }
    });
    const third = await lifecycle('native-third', 'fork');
    writeFileSync(gateTwo, 'go');
    const replacement = await acquireRuntimeControllerWhenAvailable(home);
    controllers.push(replacement);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    const current = await snapshot(next, 'agent', main.generation, 'segment-third');
    expect(current.segment_id).toBe(third.id);
    expect(current.data).toContain('?1006h');
    expect(current.data).toContain('?1002h');
    const observed = await next.request({ t: 'events', after: 0 });
    if (observed.t !== 'events' || observed.page.gap) throw new Error('Incomplete history');
    // The database transaction is exercised separately in the binding tests.
    await next.request({
      t: 'bind-placement',
      binding: {
        segment_id: third.id,
        session_id: randomUUID(),
        through: observed.page.through,
      },
    });
    await next.request({
      placement: placement(next),
      t: 'input',
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'printf \'main-%s\\n\' "$mainState"\n',
    });
    await snapshot(next, 'agent', main.generation, 'main-retained');
    await next.request({
      placement: placement(next),
      t: 'input',
      term: 'shell-1',
      generation: shell.generation,
      source: 'human',
      data: 'printf \'extra-%s\\n\' "$extra"\n',
    });
    await snapshot(next, 'shell-1', shell.generation, 'extra-retained');
    await next.request({ t: 'inspect' });
    expect(next.state!.terminals.map((term) => term.pid)).toEqual([main.pid, shell.pid]);
    expect(next.state!.history).toMatchObject({ current: third, gap: false });
    await until(() => {
      try {
        return runtimeCheckpointSchema
          .parse(
            readRuntimeJson(
              join(directory, 'segments', `${second.id}.agent.${main.generation}.json`),
            ),
          )
          .data.includes('segment-second');
      } catch {
        return false;
      }
    });
    const before = await next.request({
      t: 'segment-snapshot',
      segment_id: first.id,
      term: 'agent',
      generation: main.generation,
    });
    const middle = await next.request({
      t: 'segment-snapshot',
      segment_id: second.id,
      term: 'agent',
      generation: main.generation,
    });
    if (before.t !== 'segment-snapshot' || middle.t !== 'segment-snapshot')
      throw new Error('Missing historical checkpoint');
    expect(before.checkpoint.data).toContain('segment-first');
    expect(before.checkpoint.data).not.toContain('segment-second');
    expect(middle.checkpoint.data).toContain('segment-second');
    expect(middle.checkpoint.data).not.toContain('segment-third');
    const replay = await next.request({ t: 'events', after: 0 });
    if (replay.t !== 'events') throw new Error('Missing native transitions');
    const transitions = replay.page.events.filter((event) => event.t === 'native-lifecycle');
    expect(transitions.map((event) => [event.segment.id, event.previous_segment_id])).toEqual([
      [first.id, null],
      [second.id, first.id],
      [third.id, second.id],
    ]);
    expect(before.checkpoint.through).toBe(transitions[1]!.cursor - 1);
    expect(middle.checkpoint.through).toBe(transitions[2]!.cursor - 1);

    const exited = once(owner.child, 'exit');
    await next.request({ placement: placement(next), t: 'stop' });
    await exited;
    const text = (id: string) =>
      readFileSync(join(directory, 'logs', id, `agent.${main.generation}.log`), 'utf8');
    expect(text(first.id)).toContain('segment-first');
    expect(text(first.id)).not.toContain('segment-second');
    expect(text(second.id)).toContain('segment-second');
    expect(text(second.id)).not.toContain('segment-first');
    expect(text(second.id)).not.toContain('segment-third');
    expect(text(third.id)).toContain('segment-third');
    expect(text(third.id)).not.toContain('segment-second');
    const final = runtimeCheckpointSchema.parse(
      readRuntimeJson(join(directory, 'segments', `${third.id}.agent.${main.generation}.json`)),
    );
    expect(final.data).toContain('main-retained');
    expect(final.terminal.pid).toBeNull();
    expect(
      runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json'))).history
        .pending_checkpoints,
    ).toBe(0);
  });
});
