import { randomUUID } from 'node:crypto';
import {
  canonicalHuddleJson,
  HUDDLE_SESSION_SOURCE_LIMIT,
  sessionHuddleTrigger,
  huddleSessionSourceSchema,
  huddleSessionFeedPageSchema,
  type HuddleSessionSource,
  type HuddleSessionFeedCursor,
  type HuddleSessionFeedPage,
  type HuddleRevisionActivation,
  type HuddleDefinition,
} from '@puddle/shared';
import { HuddleStateDatabase, stateJson } from './database.js';
import { HuddleExecutions } from './executions.js';
import { HuddleActivations } from './activation.js';
import type { SessionDefinition } from '../triggers/sessions/definitions.js';

/** A page and every admitted root commit with the source cursor, or none do. */
export class HuddleSessionSources {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
    private readonly activations: HuddleActivations,
  ) {}
  private current(slot: number) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= HUDDLE_SESSION_SOURCE_LIMIT)
      throw new Error('Invalid session source slot');
    const row = this.db.get('session-sources', String(slot));
    return row ? huddleSessionSourceSchema.parse(JSON.parse(row.body)) : null;
  }
  initialise(
    definitions: SessionDefinition[],
    activation: HuddleRevisionActivation,
    cursor: HuddleSessionFeedCursor,
  ) {
    this.db.atomic(() => {
      const control = this.activations.current();
      if (control.state !== 'armed' || control.activationId !== activation.id)
        throw new Error('Huddle is not armed for session observation');
      for (const definition of definitions) {
        const existing = this.current(definition.slot);
        if (existing?.generation === control.generation && existing.activationId === activation.id)
          continue;
        const source = huddleSessionSourceSchema.parse({
          slot: definition.slot,
          node: definition.node,
          activationId: activation.id,
          revision: activation.revision,
          generation: control.generation,
          scope: {
            profileId: this.db.identity.profileId,
            projectId: this.db.identity.projectId,
            worktree: definition.worktree,
            ...(definition.session ? { sessionId: definition.session } : {}),
            excludeSessionId: this.db.identity.sessionId,
            kinds: definition.kinds,
            events: definition.events,
          },
          statuses: definition.statuses,
          cursor,
        });
        this.db.put('session-sources', String(definition.slot), activation.id, 'current', source, {
          bytes: 4096,
        });
      }
    });
  }
  list() {
    const control = this.activations.current();
    if (control.state !== 'armed') return [];
    return Array.from({ length: HUDDLE_SESSION_SOURCE_LIMIT }, (_, slot) =>
      this.current(slot),
    ).filter(
      (source): source is HuddleSessionSource =>
        !!source &&
        source.generation === control.generation &&
        source.activationId === control.activationId,
    );
  }
  requireCurrent(input: HuddleSessionSource) {
    const expected = huddleSessionSourceSchema.parse(input),
      current = this.list().find((source) => source.slot === expected.slot);
    if (
      !current ||
      canonicalHuddleJson(stateJson(current)) !== canonicalHuddleJson(stateJson(expected))
    )
      throw new Error('Session subscription or cursor changed');
    return current;
  }
  admit(
    expected: HuddleSessionSource,
    input: HuddleSessionFeedPage,
    limits: HuddleDefinition['execution'],
  ) {
    const page = huddleSessionFeedPageSchema.parse(input);
    return this.db.atomic(() => {
      const source = this.requireCurrent(expected);
      if (page.state !== 'events')
        throw new Error(
          `Session ${source.node}: observation gap (${page.state === 'gap' ? page.reason : 'unexpected baseline'})`,
        );
      if (
        page.cursor.epoch !== source.cursor.epoch ||
        page.cursor.sequence < source.cursor.sequence
      )
        throw new Error('Session feed epoch/cursor changed');
      let admitted = 0;
      for (const record of page.records) {
        const scope = source.scope;
        if (
          record.sequence <= source.cursor.sequence ||
          record.profileId !== scope.profileId ||
          record.projectId !== scope.projectId ||
          record.worktree !== scope.worktree ||
          (scope.sessionId && record.sessionId !== scope.sessionId) ||
          record.sessionId === scope.excludeSessionId ||
          !scope.kinds.includes(record.sessionKind) ||
          !scope.events.includes(record.event)
        )
          throw new Error('Session feed record differs from its declared subscription');
        if (record.event === 'status' && !source.statuses.includes(record.status)) continue;
        const event = {
          format: 1 as const,
          id: `${source.cursor.epoch}:${source.generation}:${record.sequence}`,
          source: { node: source.node, component: sessionHuddleTrigger.id, version: 1 },
          port: 'event',
          observedAt: record.observedAt,
          scope: this.db.identity,
          revision: source.revision,
          executionId: randomUUID(),
          resource: {
            kind: 'session' as const,
            sessionId: record.sessionId,
            worktree: record.worktree,
          },
          data: record,
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
        this.db.put(
          'session-sources',
          String(source.slot),
          source.activationId,
          'current',
          { ...source, cursor: page.cursor },
          { bytes: 4096 },
        );
      return admitted;
    });
  }
}
