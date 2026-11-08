import { randomUUID } from 'node:crypto';
import { huddleEventSchema, type HuddleJson } from '@puddle/shared';
import { manualHuddleTrigger } from '../../../huddle/components/core.js';
import { HuddleLedger } from '../state/ledger.js';
import { HuddleRevisionStore } from '../state/revisions.js';

/** Internal owner admission; the application controller must authorise the caller first. */
export function admitManualHuddle(
  ledger: HuddleLedger,
  revisions: HuddleRevisionStore,
  node: string,
  idempotencyKey: string,
  data: HuddleJson,
) {
  const control = ledger.activations.current();
  if (control.state !== 'armed' || !control.activationId) throw new Error('Huddle is not armed');
  const activation = ledger.activations.get(control.activationId);
  const snapshot = revisions.read(activation.revision);
  if (snapshot.definition.execution.queue !== 'queue')
    throw new Error('This owner does not yet support coalescing/drop admission');
  const definition = snapshot.definition.nodes.find((candidate) => candidate.id === node);
  if (
    definition?.source.kind !== 'builtin' ||
    definition.source.component !== manualHuddleTrigger.id ||
    definition.source.version !== manualHuddleTrigger.version
  )
    throw new Error('Node is not a supported manual trigger');
  const event = huddleEventSchema.parse({
    format: 1,
    id: idempotencyKey,
    source: { node, component: manualHuddleTrigger.id, version: manualHuddleTrigger.version },
    port: 'event',
    observedAt: new Date().toISOString(),
    scope: ledger.identity,
    revision: snapshot.digest,
    executionId: randomUUID(),
    data,
  });
  return ledger.executions.accept(
    event,
    ledger.executions.cursor(ledger.executions.sourceKey(event)),
    idempotencyKey,
    snapshot.definition.execution,
    Date.now(),
    activation.id,
  );
}
