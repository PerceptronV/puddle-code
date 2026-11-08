import { HuddleNativeFeedback } from '../operations/native-feedback.js';
import { randomUUID } from 'node:crypto';
import {
  canonicalHuddleJson,
  completionHuddleTrigger,
  HUDDLE_COMPLETION_SOURCE_LIMIT,
  huddleCompletionSourceSchema,
  huddleJsonSchema,
  runtimeNativeTurnPageSchema,
  type HuddleCompletionBaseline,
  type HuddleCompletionSource,
  type HuddleDefinition,
  type HuddleRevisionActivation,
  type RuntimeNativeTurnPage,
} from '@puddle/shared';
import { HuddleStateDatabase, stateJson } from './database.js';
import { HuddleExecutions } from './executions.js';
import { HuddleActivations } from './activation.js';
import { validateCompletionBaselines } from '../triggers/completions/baselines.js';
import type { CompletionDefinition } from '../triggers/completions/definitions.js';

const equal = (left: unknown, right: unknown) =>
  canonicalHuddleJson(stateJson(left)) === canonicalHuddleJson(stateJson(right));

/** Exact native source progress and all admitted external roots share one transaction. */
export class HuddleCompletionSources {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
    private readonly activations: HuddleActivations,
  ) {}

  private current(slot: number) {
    const row = this.db.get('completion-sources', String(slot));
    return row ? huddleCompletionSourceSchema.parse(JSON.parse(row.body)) : null;
  }

  initialise(
    definitions: CompletionDefinition[],
    activation: HuddleRevisionActivation,
    input: HuddleCompletionBaseline[],
  ) {
    this.db.atomic(() => {
      const control = this.activations.current();
      if (
        control.state !== 'armed' ||
        control.activationId !== activation.id ||
        !equal(this.activations.get(activation.id), activation)
      )
        throw new Error('Huddle is not armed for this completion activation');
      if (
        this.list().some(
          (source) => !definitions.some((definition) => definition.node === source.node),
        )
      )
        throw new Error('Completion subscriptions changed within an activation');
      const baselines = validateCompletionBaselines(
        definitions,
        activation,
        input,
        this.db.identity,
      );
      for (const baseline of baselines) {
        const slot = baseline.slot;
        const source = huddleCompletionSourceSchema.parse({
          ...baseline,
          slot,
          activationId: activation.id,
          revision: activation.revision,
          generation: control.generation,
        });
        const existing = this.current(slot);
        if (
          existing?.generation === control.generation &&
          existing.activationId === activation.id
        ) {
          if (!equal({ ...existing, cursor: source.cursor }, source))
            throw new Error('Completion target changed within an activation');
          // A controller reconnect cannot reset either retained progress or target identity.
          continue;
        }
        this.save(source);
      }
    });
  }

  list() {
    const control = this.activations.current();
    if (control.state !== 'armed') return [];
    return Array.from({ length: HUDDLE_COMPLETION_SOURCE_LIMIT }, (_, slot) =>
      this.current(slot),
    ).filter(
      (source): source is HuddleCompletionSource =>
        !!source &&
        source.generation === control.generation &&
        source.activationId === control.activationId,
    );
  }

  requireCurrent(input: HuddleCompletionSource) {
    const expected = huddleCompletionSourceSchema.parse(input);
    const current = this.list().find((source) => source.slot === expected.slot);
    if (!current || !equal(current, expected))
      throw new Error('Completion subscription or cursor changed');
    return current;
  }

  admit(
    expected: HuddleCompletionSource,
    input: RuntimeNativeTurnPage,
    limits: HuddleDefinition['execution'],
  ) {
    const page = runtimeNativeTurnPageSchema.parse(input);
    return this.db.atomic(() => {
      const source = this.requireCurrent(expected);
      if (page.persistencePending) throw new Error('Completion source persistence is pending');
      if (page.state !== 'events')
        throw new Error(
          `Completion ${source.node}: observation gap (${page.state === 'gap' ? page.reason : 'unexpected baseline'})`,
        );
      if (
        page.cursor.epoch !== source.cursor.epoch ||
        page.cursor.sequence < source.cursor.sequence
      )
        throw new Error('Completion source epoch/cursor changed');
      // Native pages are unfiltered. Missing positions are loss, not filtered observations.
      if (
        page.records.some(
          (record, index) => record.sequence !== source.cursor.sequence + index + 1,
        ) ||
        page.cursor.sequence !== (page.records.at(-1)?.sequence ?? source.cursor.sequence)
      )
        throw new Error('Completion page omits native observations');
      let admitted = 0;
      for (const record of page.records) {
        const target = source.target;
        if (
          record.sessionId !== target.sessionId ||
          record.segmentId !== target.segmentId ||
          record.agentSessionRef !== target.nativeRef
        )
          throw new Error(
            'Completion record differs from its pinned session/segment/native identity',
          );
        // Never reset a huddle's causal budgets by turning its own completion into a fresh root.
        // Opted-in asks consume native evidence once within their existing invocation.
        new HuddleNativeFeedback(this.db).observe(source, record);
        if (record.event !== 'completed' || record.origin.kind !== 'external') continue;
        const worktree = target.identity.canonical_worktree_path;
        const runtimeId = target.identity.runtime_id;
        const data = { ...record, runtimeId, worktree };
        if (!huddleJsonSchema.safeParse(data).success)
          throw new Error(
            'Completion payload exceeds the huddle value limit; reply was not truncated',
          );
        const event = {
          format: 1 as const,
          id: `${source.cursor.epoch}:${source.generation}:${record.sequence}`,
          source: { node: source.node, component: completionHuddleTrigger.id, version: 1 },
          port: 'event',
          observedAt: record.observedAt,
          scope: this.db.identity,
          revision: source.revision,
          executionId: randomUUID(),
          resource: { kind: 'session' as const, sessionId: target.sessionId, runtimeId, worktree },
          data,
        };
        this.executions.accept(
          event,
          this.executions.cursor(this.executions.sourceKey(event)),
          { epoch: source.cursor.epoch, sequence: record.sequence },
          limits,
          Date.now(),
          source.activationId,
        );
        admitted++;
      }
      if (page.cursor.sequence !== source.cursor.sequence)
        this.save({ ...source, cursor: page.cursor });
      return admitted;
    });
  }

  private save(source: HuddleCompletionSource) {
    this.db.put('completion-sources', String(source.slot), source.activationId, 'current', source, {
      bytes: 4096,
    });
  }
}
