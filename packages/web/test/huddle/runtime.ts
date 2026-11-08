import {
  huddleJsonSchema,
  huddleReviewSchema,
  canonicalHuddleJson,
  type HuddleJson,
  type HuddleDocument,
  type HuddleRuntimeInspection,
  type HuddleHistoryPage,
} from '@puddle/shared';

/** UI-only daemon responses; no owner, script or agent is launched. */
export function huddleRuntimeFixture(document: () => HuddleDocument) {
  let owner: HuddleRuntimeInspection['owner'] = null;
  let active: HuddleDocument | null = null;
  let variables: HuddleJson = {};
  let lose: string | null = null;
  let release: (() => void) | null = null;
  let held: Promise<void> | null = null;
  let holdAction: string | null = null;
  let observationFails = false;
  let ordinal = 0;
  const executions: Extract<HuddleHistoryPage, { collection: 'executions' }>['records'] = [];
  const nodes: Extract<HuddleHistoryPage, { collection: 'invocations' }>['records'] = [];
  const operations: Extract<HuddleHistoryPage, { collection: 'operations' }>['records'] = [];
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
    uncertainReadout() {
      const execution = executions.at(-1)!.record;
      execution.state = 'failed';
      operations.push({
        ordinal: ++ordinal,
        record: {
          id: crypto.randomUUID(),
          executionId: execution.id,
          invocationId: nodes.at(-1)!.record.id,
          kind: 'readout',
          state: 'unknown',
          consumed: true,
          error: 'Destination reply was lost',
          readout_observation: true,
        },
      });
      if (owner?.connected) owner.readout_observation = true;
    },
    readoutSupport(value: boolean) {
      if (owner?.connected) {
        if (value) owner.readout_observation = true;
        else delete owner.readout_observation;
      }
    },
    customTriggerHealth(gap: boolean) {
      if (owner?.connected)
        owner.custom_triggers = [
          { node: 'healthy', health: { state: 'ready' } },
          {
            node: 'feed',
            health: gap ? { state: 'gap', message: 'Source cursor expired' } : { state: 'closed' },
          },
        ];
    },
    async request(
      session: string,
      action: string,
      body: Record<string, unknown> | undefined,
      includeReadoutObservation = false,
      includeCustomTriggers = false,
    ) {
      if (action === holdAction) await held;
      const current = owner?.connected ? owner : null;
      if (action === 'runtime') {
        if (observationFails) return fail('observation_unavailable');
        const observed = structuredClone(owner);
        if (!includeReadoutObservation && observed?.connected) delete observed.readout_observation;
        if (!includeCustomTriggers && observed?.connected) delete observed.custom_triggers;
        return Response.json({ session_id: session, owner: observed, unresolved: false });
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
              : operations.filter(({ record }) => record.executionId === body?.parent);
        const records = structuredClone(
          rows.filter(({ ordinal }) => ordinal > Number(body?.after)).slice(0, 2),
        );
        if (!body?.include_readout_observation)
          for (const { record } of records)
            if ('readout_observation' in record) delete record.readout_observation;
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
      if (action === 'readouts/observe') {
        const operation = operations.find(({ record }) => record.id === body?.operation_id)?.record;
        if (!operation || !current?.readout_observation) return fail('huddle_command_rejected');
        operation.state = 'completed';
        operation.result = { status: 'delivered', receipt: { id: 'observed-destination' } };
        delete operation.error;
        delete operation.readout_observation;
        if (lose === action) {
          lose = null;
          throw new TypeError('Reply lost after observation acceptance');
        }
        return Response.json({ accepted: true, operation_id: operation.id });
      }
      if (action === 'revision' || action === 'diff') {
        if (!active || !current) return fail('huddle_unavailable');
        const saved = action === 'diff' ? document() : null;
        if (saved && body?.expected_digest !== saved.digest) return fail('huddle_source_changed');
        const entries = [];
        let content;
        const selected = body?.entry as { kind: string; path: string } | undefined;
        const fingerprint = async (value: string | undefined) => {
          if (value === undefined) return null;
          const bytes = new TextEncoder().encode(value);
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
          return { bytes: bytes.length, digest };
        };
        for (const kind of ['file', 'component'] as const) {
          const values = (d: HuddleDocument | null): Record<string, string> =>
            !d
              ? {}
              : kind === 'file'
                ? {
                    'huddle.json': JSON.stringify(d.definition, null, 2),
                    ...(d.layout ? { 'layout.json': JSON.stringify(d.layout, null, 2) } : {}),
                  }
                : Object.fromEntries(
                    Object.entries(d.components).map(([key, value]) => [
                      key,
                      canonicalHuddleJson(value as unknown as HuddleJson),
                    ]),
                  );
          const a = values(active),
            b = values(saved);
          for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
            const entry = { kind, path };
            entries.push({
              entry,
              before: await fingerprint(a[path]),
              after: await fingerprint(b[path]),
              change: !saved
                ? 'retained'
                : a[path] === b[path]
                  ? 'unchanged'
                  : a[path] === undefined
                    ? 'added'
                    : b[path] === undefined
                      ? 'removed'
                      : 'modified',
            });
            if (selected?.kind === kind && selected.path === path)
              content = { entry, before: a[path] ?? null, after: b[path] ?? null };
          }
        }
        return Response.json(
          huddleReviewSchema.parse({
            target: current.target,
            active: {
              id: current.target.activationId,
              revision: active.digest,
              worktree: '/preview/puddle',
              variables,
              bindings: {},
              appliedAt: 1,
            },
            saved: saved ? { digest: saved.digest, diagnostics: saved.diagnostics } : null,
            entries,
            ...(content ? { content } : {}),
          }),
        );
      }
      if (action === 'start' || action === 'apply') {
        if (body?.expected_digest !== document().digest) return fail('huddle_source_changed');
        if (action === 'start' && owner) return fail('huddle_owned');
        active = structuredClone(document());
        variables = huddleJsonSchema.parse(body?.variables);
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
