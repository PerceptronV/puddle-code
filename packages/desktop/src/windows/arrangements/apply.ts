import type {
  DesktopArrangementApplyRequest,
  DesktopArrangementCommand,
  DesktopArrangementObservation,
  DesktopArrangementPlan,
  DesktopArrangementPlanCommand,
  DesktopWorkspaceVersion,
} from '@puddle/shared';
import { desktopArrangementPlanSchema } from '@puddle/shared';
import { reopenWindowId, type ReopenWindow } from '../../reopen.js';
import type { DesktopWindowState } from '../persistence/state.js';
import { matchArrangementWindows } from './matching.js';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const message = (error: unknown) =>
  (error instanceof Error ? error.message : 'Could not apply the window layout').slice(0, 2048);
async function together<T>(operations: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

/** One native transaction owns matching, renderer votes and retirement; refresh/quit share its lock. */
export class WindowLayoutApply {
  private readonly live = new Map<string, { ownerId: string; profileId: string }>();
  constructor(
    private readonly dependencies: {
      state(): DesktopWindowState;
      admit(id: string): ReopenWindow;
      record(id: string): ReopenWindow;
      run(target: string, key: string, action: () => Promise<void>): Promise<void>;
      validate(ids: string[], arrangementId?: string): void;
      generation(id: string): number | null;
      ready(id: string): Promise<void>;
      command(
        id: string,
        command: DesktopArrangementCommand,
      ): Promise<DesktopWorkspaceVersion | undefined>;
      plan(
        id: string,
        command: DesktopArrangementPlanCommand,
      ): Promise<DesktopArrangementPlan | undefined>;
      open(record: ReopenWindow): Promise<void>;
      dismiss(id: string): void;
      reload(id: string): Promise<void>;
      committed(): void;
      report(error: unknown): void;
    },
  ) {}

  observe(
    ownerId: string,
    request: { id: string; profileId: string },
  ): DesktopArrangementObservation {
    const live = this.live.get(request.id);
    if (live && (live.ownerId !== ownerId || live.profileId !== request.profileId))
      throw new Error('Arrangement belongs to another window or profile');
    return {
      status:
        this.dependencies.state().arrangementOutcome(request.id, ownerId, request.profileId) ??
        (live ? 'prepared' : 'unknown'),
    };
  }

  async apply(
    ownerId: string,
    request: DesktopArrangementApplyRequest,
  ): Promise<DesktopArrangementObservation> {
    const source = this.dependencies.admit(ownerId);
    if (source.window?.kind !== 'host') throw new Error('Manage window layouts from a host window');
    if (this.dependencies.state().outcome(request.id))
      throw new Error('A transfer already uses this operation id');
    if (this.observe(ownerId, request).status !== 'unknown')
      throw new Error('Layout already requested; inspect its recorded outcome');
    this.live.set(request.id, { ownerId, profileId: request.profileId });
    let result: DesktopArrangementObservation = { status: 'unknown' };
    try {
      await this.dependencies.run(source.target, `layout-apply:${request.id}`, async () => {
        result = await this.perform(ownerId, request);
      });
      return result;
    } finally {
      this.live.delete(request.id);
    }
  }

  private async perform(
    ownerId: string,
    request: DesktopArrangementApplyRequest,
  ): Promise<DesktopArrangementObservation> {
    const state = this.dependencies.state();
    const scope = {
      ownerId,
      profileId: request.profileId,
      scope: request.scope,
      projectId: request.projectId,
    };
    const original = state.arrangementEntries(scope);
    const live = original
      .filter((entry) => entry.open)
      .map((entry) => reopenWindowId(entry.record));
    const generations = new Map(live.map((id) => [id, this.dependencies.generation(id)]));
    const fresh: string[] = [];
    const prepared = new Map<string, DesktopWorkspaceVersion>();
    let attempted = false;
    let committed = false;
    const common = { arrangementId: request.id, profileId: request.profileId };
    const validate = (ids: string[], prepared = false) => {
      this.dependencies.validate(ids, prepared ? request.id : undefined);
      for (const id of ids)
        if (this.dependencies.generation(id) !== generations.get(id))
          throw new Error('A window renderer changed while applying the layout');
    };
    const finish = async (id: string, outcome: 'committed' | 'cancelled') => {
      // A replaced renderer lost its in-memory original. On cancellation only,
      // reload from the already restored durable state; never erase live edits
      // merely because a finish acknowledgement was lost.
      if (this.dependencies.generation(id) !== generations.get(id)) {
        if (outcome === 'cancelled') await this.dependencies.reload(id);
        return;
      }
      const command = { ...common, kind: 'finish-layout' as const, outcome };
      try {
        return await this.dependencies.command(id, command);
      } catch (error) {
        if (this.dependencies.generation(id) !== generations.get(id)) throw error;
        return await this.dependencies.command(id, command); // exact terminal observation is idempotent
      }
    };
    try {
      validate(live);
      const records = new Map(live.map((id) => [id, this.dependencies.record(id)]));
      attempted = true;
      const captured = await together(
        live.map((id) => this.dependencies.command(id, { ...common, kind: 'seal-layout' })),
      );
      validate(live);
      for (const [index, id] of live.entries()) {
        if (!captured[index] || !equal(captured[index], state.read(id, request.profileId)))
          throw new Error('A sealed window did not match its durable revision');
        if (!equal(records.get(id)?.route, this.dependencies.record(id).route))
          throw new Error('A window route changed during layout capture');
      }
      const current = state.arrangementEntries(scope);
      const membership = (entries: typeof current) =>
        entries.map((entry) => [
          reopenWindowId(entry.record),
          entry.record.window,
          entry.open,
          entry.returnedProject,
        ]);
      if (!equal(membership(current), membership(original)))
        throw new Error('Window arrangement membership changed');
      const candidates = state.arrangementEntries(scope, true).map((entry) => ({
        ...entry,
        record: records.get(reopenWindowId(entry.record)) ?? entry.record,
      }));
      const matched = matchArrangementWindows(ownerId, request, candidates);
      const planned = desktopArrangementPlanSchema.parse(
        await this.dependencies.plan(ownerId, {
          kind: 'plan-layout',
          ownerId,
          request,
          entries: matched.entries.map((entry) => ({
            identity: entry.record.window!,
            route: entry.record.route,
            open: entry.open,
            returnedProject: entry.returnedProject,
            version: entry.version,
          })),
          slots: matched.slots,
        }),
      );
      validate(live);
      const changes = new Map(planned.changes.map((change) => [change.id, change]));
      if (
        changes.size !== planned.changes.length ||
        changes.size !== matched.entries.length ||
        matched.entries.some((entry) => !changes.has(reopenWindowId(entry.record)))
      )
        throw new Error('The renderer changed the native window plan');
      const transaction = state.prepareArrangement({
        ...scope,
        id: request.id,
        changes: matched.entries.map((entry) => {
          const id = reopenWindowId(entry.record);
          const change = changes.get(id)!;
          const identity = entry.record.window!;
          if (
            matched.openIds.has(id) &&
            identity.kind !== 'host' &&
            (change.route !== `/project/${identity.projectId}` ||
              change.content.snapshot.layout_mode !== 'profile' ||
              Object.keys(change.content.snapshot.project_layouts).length)
          )
            throw new Error('A detached layout must keep its anchored workspace');
          return {
            record: { ...entry.record, route: change.route },
            revision: entry.version?.revision ?? 0,
            content: change.content,
            open: matched.openIds.has(id),
          };
        }),
      });
      for (const change of transaction.changes)
        prepared.set(reopenWindowId(change.record as ReopenWindow), {
          revision: change.revision,
          content: change.content,
        });
      for (const entry of matched.entries)
        if (matched.openIds.has(reopenWindowId(entry.record)) && !entry.open)
          fresh.push(reopenWindowId(entry.record));
      await together(
        fresh.map(async (id) => {
          const change = transaction.changes.find(
            (change) => reopenWindowId(change.record as ReopenWindow) === id,
          )!;
          await this.dependencies.open(change.record as ReopenWindow);
          await this.dependencies.ready(id);
          generations.set(id, this.dependencies.generation(id));
        }),
      );
      validate([...live, ...fresh], true);
      await together(
        [...matched.openIds].map(async (id) => {
          const version = state.readPresentation(id, request.profileId)!;
          const accepted = await this.dependencies.command(id, {
            ...common,
            kind: 'stage-layout',
            version,
            route: changes.get(id)!.route,
          });
          if (!equal(accepted, version))
            throw new Error('A window did not accept its prepared layout');
        }),
      );
      validate([...live, ...fresh], true);
      await together(
        [...live, ...fresh].map(async (id) => {
          const expected = matched.openIds.has(id)
            ? state.readPresentation(id, request.profileId)
            : state.read(id, request.profileId);
          if (
            !equal(
              await this.dependencies.command(id, { ...common, kind: 'verify-layout' }),
              expected,
            )
          )
            throw new Error('A window changed before confirming the arrangement');
        }),
      );
      validate([...live, ...fresh], true);
      state.commitArrangement(request.id, ownerId);
      committed = true;
      this.dependencies.committed();
      await together([...matched.openIds].map((id) => finish(id, 'committed')));
      for (const id of live) if (!matched.openIds.has(id)) this.dependencies.dismiss(id);
      return { status: 'committed' };
    } catch (error) {
      this.dependencies.report(error);
      if (committed || state.arrangementOutcome(request.id, ownerId) === 'committed') {
        // Retirement is safe after the durable commit even if a survivor's final
        // reply was lost. Reopen state is authoritative; never replay the apply.
        const open = new Set(state.openWindows().map(reopenWindowId));
        for (const id of live) if (!open.has(id)) this.dependencies.dismiss(id);
        return { status: 'committed', error: message(error) };
      }
      try {
        state.cancelArrangementPreparation(request.id, ownerId, request.profileId);
      } catch (failure) {
        this.dependencies.report(failure);
        return { status: this.observe(ownerId, request).status, error: message(failure) };
      }
      this.dependencies.committed(); // discard staged registrations before asynchronous rollback
      // Cancellation must reach every source, including failed/lost seal replies.
      // New destinations stay fenced and can be destroyed only after that write.
      const rolledBack = await Promise.allSettled(
        attempted ? live.map((id) => finish(id, 'cancelled')) : [],
      );
      for (const result of rolledBack)
        if (result.status === 'rejected') this.dependencies.report(result.reason);
      await Promise.all(
        fresh.map(async (id) => {
          if (
            this.dependencies.generation(id) !== generations.get(id) ||
            this.dependencies.generation(id) === null
          ) {
            this.dependencies.dismiss(id);
            return;
          }
          try {
            const recovered = await finish(id, 'cancelled');
            const planned = prepared.get(id)!;
            if (!recovered)
              throw new Error('The cancelled destination did not confirm its final draft capture');
            if (
              equal(recovered.content.buffers, planned.content.buffers) &&
              equal(recovered.content.snapshot, planned.content.snapshot)
            ) {
              this.dependencies.dismiss(id);
              return;
            }
            state.retainArrangementRecovery(request.id, ownerId, request.profileId, id, recovered);
            this.dependencies.committed();
            if (
              !equal(
                await this.dependencies.command(id, { ...common, kind: 'verify-layout' }),
                recovered,
              )
            )
              throw new Error('The recovery window changed before accepting its retained drafts');
            await finish(id, 'committed');
            this.dependencies.report(
              new Error(
                'An edit finished during layout cancellation; its latest text remains in a recovery window',
              ),
            );
          } catch (failure) {
            // Keep the fenced renderer available when its final drafts cannot be
            // confirmed. Never destroy it on a lost recovery acknowledgement.
            this.dependencies.report(failure);
          }
        }),
      );
      return { status: 'cancelled', error: message(error) };
    }
  }
}
