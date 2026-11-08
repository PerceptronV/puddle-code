import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  huddleEventSchema,
  type HuddleInvocationRecord,
  type HuddleWorkerRequest,
  type RuntimeIdentity,
} from '@puddle/shared';
import { spawnGraphSnapshot } from './spawn-graph.js';
import { HuddleLedger } from '../../../src/runtime/huddle/state/ledger.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { HuddlePendingOperations } from '../../../src/runtime/huddle/operations/pending.js';
import { HuddleSpawnMailbox } from '../../../src/runtime/huddle/operations/spawns/mailbox.js';
import { HuddleOperationMailbox } from '../../../src/runtime/huddle/operations/mailbox.js';
import type { RuntimeByteAllowance } from '../../../src/runtime/resources/budget.js';

export function spawnMailboxFixture(
  input?: {
    home: string;
    identity: RuntimeIdentity;
    huddleId: string;
    accountId: number;
    agent: string;
  },
  allowance?: RuntimeByteAllowance,
) {
  const home = input?.home ?? mkdtempSync(join(tmpdir(), 'puddle-spawn-mailbox-'));
  const identity: RuntimeIdentity = input?.identity ?? {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    profile_id: '0123456789',
    project_id: 'abcdef1234',
    session_id: randomUUID(),
    canonical_worktree_path: home,
  };
  const ledgerIdentity = {
    hostId: 'fixture-host',
    profileId: identity.profile_id,
    projectId: identity.project_id,
    huddleId: input?.huddleId ?? randomBytes(16).toString('hex'),
    sessionId: identity.session_id,
    runtimeId: identity.runtime_id,
  };
  let ledger = new HuddleLedger(home, ledgerIdentity);
  const { snapshot, bindings: resolved } = spawnGraphSnapshot(ledgerIdentity.huddleId, {
    projectId: identity.project_id,
    worktree: identity.canonical_worktree_path,
    accountId: input?.accountId ?? 1,
    agent: input?.agent ?? 'runtime-test',
  });
  const bindings = resolved.worker;
  const revisions = new HuddleRevisionStore(home, identity.runtime_id, ledgerIdentity.huddleId);
  let controller = new HuddleRevisionController(ledger, revisions);
  const activation = controller.apply(
    snapshot,
    {
      id: randomUUID(),
      worktree: bindings.worktree,
      variables: {},
      bindings: { worker: bindings },
    },
    0,
  ).activation;
  ledger.activations.setIntent(1, 'armed', false);
  let pending: HuddlePendingOperations, spawns: HuddleSpawnMailbox, asks: HuddleOperationMailbox;
  const connect = () => {
    pending = new HuddlePendingOperations(ledger, () => {}, allowance);
    spawns = new HuddleSpawnMailbox(identity, ledger, controller, () => {}, pending);
    asks = new HuddleOperationMailbox(
      identity,
      ledger,
      controller,
      () => {},
      undefined,
      spawns,
      pending,
    );
  };
  connect();
  let cursor = 0;
  const execution = () => {
    const event = huddleEventSchema.parse({
      format: 1,
      id: randomUUID(),
      source: { node: 'run', component: 'puddle.trigger.manual', version: 1 },
      port: 'event',
      observedAt: new Date().toISOString(),
      scope: ledgerIdentity,
      revision: snapshot.digest,
      executionId: randomUUID(),
      data: 'fixture',
    });
    const accepted = ledger.executions.accept(
      event,
      cursor === 0 ? null : cursor,
      ++cursor,
      snapshot.definition.execution,
      Date.now(),
      activation.id,
    );
    return ledger.executions.start(accepted.execution.id);
  };
  const invoke = (executionId: string) => {
    const input = {
      id: randomUUID(),
      executionId,
      revision: snapshot.digest,
      node: 'worker',
      activation: randomUUID(),
      iteration: 0,
      inputs: { value: 'fixture' },
    };
    ledger.invocations.queue(input);
    return ledger.invocations.start(input.id, Date.now(), 32);
  };
  const invocation = invoke(execution().id);
  const request = (): HuddleWorkerRequest => ({
    type: 'request',
    id: randomUUID(),
    action: {
      kind: 'operation',
      operation: {
        op: 'spawn',
        options: {
          account: bindings.account,
          agent: bindings.provider,
          project: bindings.project,
          worktree: bindings.worktree,
          mode: 'headless',
          title: 'Spawn fixture',
        },
      },
    },
  });
  const aborts: AbortController[] = [];
  const begin = (message = request(), node: HuddleInvocationRecord = invocation) => {
    const abort = new AbortController();
    aborts.push(abort);
    const waiting = spawns.request(message, node, abort.signal);
    void waiting.catch(() => {});
    return { message, abort, waiting };
  };
  return {
    home,
    identity,
    snapshot,
    activation,
    bindings,
    invocation,
    request,
    begin,
    execution,
    invoke,
    get ledger() {
      return ledger;
    },
    get spawns() {
      return spawns;
    },
    get asks() {
      return asks;
    },
    get controller() {
      return controller;
    },
    reconnect: connect,
    reopen() {
      ledger.close();
      ledger = new HuddleLedger(home, ledgerIdentity);
      controller = new HuddleRevisionController(ledger, revisions);
      connect();
    },
    close() {
      for (const abort of aborts) abort.abort(new Error('Fixture closed'));
      ledger.close();
      if (!input) rmSync(home, { recursive: true, force: true });
    },
  };
}
