import {
  huddleAgentTargetSchema,
  huddleLifecycleTargetSchema,
  huddleSpawnOutcomeSchema,
  type HuddleHistoryAgent,
  type HuddleOperationRecord,
} from '@puddle/shared';

/** Only host-validated operation identities become links; arbitrary node outputs do not. */
export function historyAgent(record: HuddleOperationRecord): HuddleHistoryAgent | undefined {
  if (['spawn', 'resume', 'restart'].includes(record.kind) && record.state === 'completed') {
    const outcome = huddleSpawnOutcomeSchema.safeParse(record.result);
    if (outcome.success) return project(outcome.data.agent);
  }
  if (record.kind === 'ask') {
    const target = huddleAgentTargetSchema.safeParse(record.target);
    if (target.success) return project(target.data);
  }
  if (record.kind === 'resume' || record.kind === 'restart') {
    const target = huddleLifecycleTargetSchema.safeParse(record.target);
    if (target.success)
      return project({
        ...target.data,
        ...(target.data.runtime ? { runtimeId: target.data.runtime.runtimeId } : {}),
      });
  }
}

function project(value: HuddleHistoryAgent): HuddleHistoryAgent {
  return {
    sessionId: value.sessionId,
    projectId: value.projectId,
    worktree: value.worktree,
    ...(value.runtimeId ? { runtimeId: value.runtimeId } : {}),
  };
}
