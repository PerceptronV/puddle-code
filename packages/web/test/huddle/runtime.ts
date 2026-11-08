import {
  huddleJsonSchema,
  type HuddleDocument,
  type HuddleRuntimeInspection,
  type HuddleHistoryPage,
} from '@puddle/shared';

/** UI-only daemon responses; no owner, script or agent is launched. */
export function huddleRuntimeFixture(document: () => HuddleDocument) {
  let owner: HuddleRuntimeInspection['owner'] = null;
  let active: HuddleDocument | null = null;
  let lose: string | null = null;
  let release: (() => void) | null = null;
  let held: Promise<void> | null = null;
  let holdAction: string | null = null;
  let observationFails = false;
  let ordinal = 0;
  const executions: Extract<HuddleHistoryPage, { collection: 'executions' }>['records'] = [];
  const nodes: Extract<HuddleHistoryPage, { collection: 'invocations' }>['records'] = [];
  const fail = (code: string) =>
    Response.json({ error: { code, message: code.replaceAll('_', ' ') } }, { status: 409 });
  return {
    failObservation(value: boolean) {
      observationFails = value;
    },
    loseNext(action: string) {
      lose = action;
    },
    holdNext(action: string) {
      holdAction = action;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      held = null;
      holdAction = null;
    },
    state: () => owner,
    executions: () => executions,
    async request(session: string, action: string, body: Record<string, unknown> | undefined) {
      if (action === holdAction) await held;
      const current = owner?.connected ? owner : null;
      if (action === 'runtime') {
        if (observationFails) return fail('observation_unavailable');
        return Response.json({ session_id: session, owner, unresolved: false });
      }
      if (action === 'history') {
        if (
          !current ||
          JSON.stringify(body?.owner) !==
            JSON.stringify({
              runtimeId: current.target.runtimeId,
              incarnation: current.target.incarnation,
            })
        )
          return fail('huddle_unavailable');
        const collection = body?.collection;
        const rows =
          collection === 'executions'
            ? executions
            : collection === 'invocations'
              ? nodes.filter(({ record }) => record.executionId === body?.parent)
              : [];
        const records = rows.filter(({ ordinal }) => ordinal > Number(body?.after)).slice(0, 2);
        return Response.json({
          owner: body?.owner,
          collection,
          records,
          next: records.at(-1)?.ordinal ?? body?.after,
        });
      }
      if (
        action !== 'start' &&
        (!current || JSON.stringify(body?.target) !== JSON.stringify(current.target))
      )
        return fail('huddle_control_changed');
      if (action === 'start' || action === 'apply') {
        if (body?.expected_digest !== document().digest) return fail('huddle_source_changed');
        if (action === 'start' && owner) return fail('huddle_owned');
        active = structuredClone(document());
        owner = {
          connected: true,
          target: {
            runtimeId: current?.target.runtimeId ?? crypto.randomUUID(),
            incarnation: current?.target.incarnation ?? crypto.randomUUID(),
            generation: (current?.target.generation ?? 0) + 1,
            activationId: crypto.randomUUID(),
          },
          build: 'fixture',
          lifetime: 'service',
          lifecycle: 'armed',
          executing: false,
          stopping: false,
          failure: null,
        };
      } else if (action === 'stop') owner = null;
      else if (action === 'interrupt' || action === 'rearm') {
        if (current)
          owner = {
            ...current,
            target: { ...current.target, generation: current.target.generation + 1 },
            lifecycle: action === 'rearm' ? 'armed' : 'interrupted',
          };
      } else if (action === 'run') {
        if (
          !current ||
          current.lifecycle !== 'armed' ||
          !active?.definition.nodes.some(
            (node) =>
              node.id === body?.node &&
              node.source.kind === 'builtin' &&
              node.source.component === 'puddle.trigger.manual',
          )
        )
          return fail('huddle_command_rejected');
        const id = crypto.randomUUID();
        executions.push({
          ordinal: ++ordinal,
          record: {
            id,
            revision: active.digest,
            activationId: current.target.activationId!,
            state: 'completed',
            acceptedAt: Date.now(),
            deadline: Date.now() + 1000,
            turns: 0,
            spawns: 0,
            invocations: 1,
          },
        });
        const data = huddleJsonSchema.parse(body?.data);
        nodes.push({
          ordinal: ++ordinal,
          record: {
            id: crypto.randomUUID(),
            executionId: id,
            revision: active.digest,
            node: 'result',
            iteration: 0,
            state: 'completed',
            inputs: data,
            result: { delivered: data },
          },
        });
        if (lose === action) {
          lose = null;
          throw new TypeError('Reply lost after acceptance');
        }
        return Response.json({ executionId: id, duplicate: false });
      }
      if (lose === action) {
        lose = null;
        throw new TypeError('Reply lost after acceptance');
      }
      return action === 'stop'
        ? Response.json({ stopped: true })
        : Response.json({ session_id: session, owner, unresolved: false });
    },
  };
}
