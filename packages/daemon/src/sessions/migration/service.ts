import { existsSync } from 'node:fs';
import type { Account, Session } from '@puddle/shared';
import type { AgentAdapter } from '../../agents/adapter.js';
import { assertBinaryAvailable } from '../../agents/binary.js';
import { ApiError } from '../../http/errors.js';
import type { RuntimeLaunchGuard } from '../../runtime/lifecycle/launcher.js';
import type { SessionServiceDeps } from '../service.js';

type Dependencies = Pick<
  SessionServiceDeps,
  | 'sessions'
  | 'accounts'
  | 'projects'
  | 'profiles'
  | 'adapters'
  | 'runtimes'
  | 'runtimeControls'
  | 'share'
  | 'events'
  | 'onboarding'
>;
interface Operations {
  checkLoggedIn(account: Account, adapter: AgentAdapter): Promise<void>;
  kill(id: string, authorised: () => boolean): Promise<Session>;
  resume(
    session: Session,
    account: Account,
    adapter: AgentAdapter,
    profile: string,
    ref: string,
    guard: RuntimeLaunchGuard,
  ): Promise<unknown>;
}

const accountIdentity = (account: Account) =>
  JSON.stringify({
    id: account.id,
    profile: account.profile_id,
    agent: account.agent_type,
    directory: account.config_dir,
  });
const placementIdentity = (session: Session) =>
  JSON.stringify({
    project: session.project_id,
    kind: session.kind,
    agent: session.agent_type,
    mode: session.agent_mode,
    conversation: session.conversation_id,
    ref: session.agent_session_ref,
    missing: session.conversation_missing,
    worktree: session.worktree_path,
  });

/** Caller serialises resume/migration; provider-native changes still require exact reinspection. */
export async function migrateSessionAccount(
  deps: Dependencies,
  id: string,
  targetAccountId: number,
  authorised: () => boolean,
  operations: Operations,
): Promise<void> {
  const changed = () =>
    ApiError.conflict('session_changed', 'The session or account changed during migration.');
  const authority = () => {
    if (!authorised()) throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
  };
  authority();
  const session = deps.sessions.get(id);
  if (session.kind === 'terminal' || session.account_id === null || session.agent_type === null)
    throw ApiError.badRequest('not_migratable', 'a terminal session has no account to migrate');
  const project = deps.projects.get(session.project_id);
  const source = deps.accounts.get(session.account_id);
  const target = deps.accounts.get(targetAccountId);
  if (source.profile_id !== project.profile_id || source.agent_type !== session.agent_type)
    throw changed();
  if (target.profile_id !== project.profile_id)
    throw ApiError.badRequest(
      'cross_profile_account',
      'the target account belongs to a different profile',
    );
  if (target.agent_type !== session.agent_type)
    throw ApiError.badRequest(
      'agent_mismatch',
      `the target account runs ${target.agent_type}, not ${session.agent_type}`,
    );
  if (target.id === source.id)
    throw ApiError.badRequest('same_account', 'the session already runs on this account');
  if (session.status === 'archived')
    throw ApiError.conflict('session_archived', 'an archived session cannot migrate');
  if (!existsSync(session.worktree_path))
    throw ApiError.conflict(
      'worktree_missing',
      'worktree is gone; the session can only be archived',
    );
  const ref = session.agent_session_ref;
  if (!ref || session.conversation_missing)
    throw ApiError.conflict('no_session_ref', 'no available agent session ref recorded');
  const adapter = deps.adapters.get(session.agent_type);
  if (!adapter.capabilities.resume)
    throw ApiError.badRequest(
      'resume_unsupported',
      `${adapter.displayName} cannot resume conversations`,
    );
  if (!adapter.conversationShare && !adapter.migrateSession)
    throw ApiError.conflict(
      'migration_unsupported',
      `${adapter.displayName} cannot migrate this conversation to another account`,
    );

  const owner = deps.runtimes?.ownerOf(id);
  const selected = deps.runtimes?.selectedOwner(id)?.runtime_id ?? null;
  if (owner && (owner.active_session_id !== id || owner.account_id !== source.id)) throw changed();
  let expectedAccount = source.id;
  const check = (stopped = false) => {
    authority();
    const current = deps.sessions.get(id);
    const account = deps.accounts.get(target.id);
    if (
      current.status === 'archived' ||
      current.account_id !== expectedAccount ||
      deps.projects.get(session.project_id).profile_id !== project.profile_id ||
      placementIdentity(current) !== placementIdentity(session) ||
      accountIdentity(deps.accounts.get(source.id)) !== accountIdentity(source) ||
      accountIdentity(account) !== accountIdentity(target) ||
      account.logged_in !== verifiedTarget.logged_in ||
      account.skip_permissions_default !== verifiedTarget.skip_permissions_default ||
      (deps.runtimes?.selectedOwner(id)?.runtime_id ?? null) !== selected
    )
      throw changed();
    if (stopped) {
      if (deps.runtimes?.ownerOf(id) || !['exited', 'interrupted'].includes(current.status))
        throw changed();
      if (owner && deps.runtimes?.get(owner.runtime_id)?.state !== 'exited') throw changed();
    }
  };
  assertBinaryAvailable(adapter);
  await operations.checkLoggedIn(target, adapter);
  const verifiedTarget = deps.accounts.get(target.id);
  check();
  if (owner) {
    if (!deps.runtimeControls) throw changed();
    await deps.runtimeControls.stop(id, authorised, (state) => {
      check();
      const current = deps.runtimes?.ownerOf(id);
      if (
        current?.runtime_id !== owner.runtime_id ||
        current.account_id !== source.id ||
        current.active_segment_id !== owner.active_segment_id ||
        state.identity.runtime_id !== owner.runtime_id ||
        state.identity.incarnation !== owner.incarnation ||
        state.identity.launch_id !== owner.launch_id ||
        state.history.current.agent_session_ref !== ref ||
        state.agent?.agent_session_ref !== ref
      )
        throw changed();
    });
    deps.events.record(id, 'killed');
  } else if (['starting', 'running', 'waiting_input'].includes(session.status)) {
    await operations.kill(id, authorised);
  }
  check(true);
  // Reuse the shared-store adoption and adapter-copy fall-through. Neither path
  // may start until the old owner has closed its PTYs and provider resources.
  if (deps.share) {
    try {
      await deps.share.adoptIfNeeded(session);
    } catch {
      /* Availability below remains authoritative. */
    }
    check(true);
  }
  let rollback: (() => Promise<void>) | null = null;
  const canRollback = () => {
    try {
      return (
        !deps.runtimes?.ownerOf(id) &&
        (deps.runtimes?.selectedOwner(id)?.runtime_id ?? null) === selected &&
        deps.sessions.get(id).account_id === expectedAccount &&
        placementIdentity(deps.sessions.get(id)) === placementIdentity(session) &&
        accountIdentity(deps.accounts.get(source.id)) === accountIdentity(source) &&
        accountIdentity(deps.accounts.get(target.id)) === accountIdentity(target)
      );
    } catch {
      return false;
    }
  };
  try {
    const shared =
      adapter.conversationShare && (await adapter.hasConversation?.(ref, verifiedTarget));
    check(true);
    if (!shared) {
      if (!adapter.migrateSession)
        throw ApiError.conflict(
          'migration_unsupported',
          `${adapter.displayName} cannot migrate this conversation to another account`,
        );
      await adapter.migrateSession(ref, source, verifiedTarget, session.worktree_path);
      rollback = () => adapter.migrateSession!(ref, verifiedTarget, source, session.worktree_path);
      check(true);
    }
    deps.sessions.setAccountId(id, target.id);
    expectedAccount = target.id;
    check(true);
    await operations.resume(session, verifiedTarget, adapter, project.profile_id, ref, () => {
      check(true);
      // resumeSpawn recalculates this flag for the target. Do not let a later
      // profile/account policy change cross the asynchronous launch boundary.
      if (
        deps.sessions.get(id).skip_permissions &&
        (!deps.profiles.getSettings(project.profile_id).allowSkipPermissions ||
          !deps.accounts.get(target.id).skip_permissions_default)
      )
        throw changed();
    });
  } catch (error) {
    // A prepared/failed replacement still owns its launch and copied native data.
    // selectedOwner changes at durable intent, unlike ownerOf's live-only query.
    if (rollback && canRollback()) {
      try {
        await rollback();
      } catch {
        /* Keep the existing best-effort adapter rollback contract. */
      }
      if (canRollback()) deps.sessions.setAccountId(id, source.id);
    }
    throw error;
  }
  deps.events.record(id, 'migrated', { from_account: source.id, to_account: target.id });
  deps.onboarding.watch(id, project.repo_id, session.worktree_path);
}
