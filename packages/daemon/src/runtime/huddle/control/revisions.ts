import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  huddleRevisionActivationSchema,
  resolveHuddleParameters,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../huddle/definitions/capture.js';
import { restoreHuddleDefinition } from '../../../huddle/definitions/restore.js';
import { HuddleLedger } from '../state/ledger.js';
import { intervalDefinitions } from '../triggers/definitions.js';
import { scheduleDefinitions } from '../triggers/calendar/definitions.js';
import { HuddleRevisionStore } from '../state/revisions.js';

/** Pure source/binding validation shared by daemon admission and the independent owner. */
export function prepareHuddleActivation(
  snapshot: HuddleDefinitionSnapshot,
  input: Omit<HuddleRevisionActivation, 'revision' | 'appliedAt'>,
  huddleId: string,
) {
  const restored = restoreHuddleDefinition(
    {
      format: snapshot.format,
      digest: snapshot.digest,
      files: snapshot.files,
      components: snapshot.components,
    },
    huddleId,
  );
  if (!isAbsolute(input.worktree))
    throw new Error('Huddle source worktree must be explicit and absolute');
  const activation = huddleRevisionActivationSchema.parse({
    ...input,
    revision: restored.digest,
    worktree: realpathSync(input.worktree),
    appliedAt: Date.now(),
  });
  const nodes = new Set(restored.definition.nodes.map((node) => node.id));
  for (const node of Object.keys(activation.bindings)) {
    if (!nodes.has(node)) throw new Error('Resolved bindings contain an unknown node');
  }
  for (const node of restored.definition.nodes) {
    const component = restored.components[node.id]!;
    const parameters = resolveHuddleParameters(
      restored.definition,
      node,
      component,
      activation.variables,
    );
    const bindings = activation.bindings[node.id] ?? {};
    for (const key of Object.keys(bindings)) {
      const parameter = component.parameters[key];
      if (
        !parameter ||
        !['worktree', 'account', 'session', 'project', 'agent'].includes(parameter.editor) ||
        parameters[key] === undefined
      )
        throw new Error('Resolved binding does not name a declared resource parameter');
    }
    for (const [key, parameter] of Object.entries(component.parameters)) {
      if (
        parameters[key] !== undefined &&
        ['worktree', 'account', 'session', 'project', 'agent'].includes(parameter.editor) &&
        !bindings[key]
      )
        throw new Error(`Resource parameter needs an explicit resolved binding: ${node.id}.${key}`);
    }
  }
  intervalDefinitions(restored, activation);
  scheduleDefinitions(restored, activation);
  return { snapshot: restored, activation };
}

/** The authorised host resolver supplies bindings; this controller never guesses account/worktree scope. */
export class HuddleRevisionController {
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly revisions: HuddleRevisionStore,
  ) {}

  apply(
    snapshot: HuddleDefinitionSnapshot,
    input: Omit<HuddleRevisionActivation, 'revision' | 'appliedAt'>,
    expectedGeneration: number,
  ) {
    const { snapshot: restored, activation } = prepareHuddleActivation(
      snapshot,
      input,
      this.ledger.identity.huddleId,
    );
    this.revisions.publish(restored);
    return this.ledger.activations.apply(activation, expectedGeneration, activation.appliedAt);
  }

  forExecution(executionId: string) {
    const execution = this.ledger.executions.get(executionId);
    if (!execution.activationId) throw new Error('Execution has no retained activation');
    const activation = this.ledger.activations.get(execution.activationId);
    if (activation.revision !== execution.revision)
      throw new Error('Execution activation revision changed');
    return { activation, snapshot: this.revisions.read(execution.revision) };
  }
}
