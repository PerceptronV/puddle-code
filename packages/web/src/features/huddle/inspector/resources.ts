import { sessionHuddleTrigger, type HuddleNodeDefinition, type Session } from '@puddle/shared';
import { useProjectDetail, useRepoWorktrees, useSessions } from '../../../lib/queries/queries';

export interface NodeResourceOptions {
  worktrees: Array<{ value: string; label: string }>;
  sessions: Array<{ value: string; label: string }>;
  error?: string;
}
export function useNodeResourceOptions(
  session: Session,
  node: HuddleNodeDefinition,
  enabled: boolean,
): NodeResourceOptions {
  const project = useProjectDetail(enabled ? session.project_id : undefined);
  const roots = useRepoWorktrees(enabled ? project.data?.project.repo_id : undefined);
  const agents = useSessions(enabled ? session.project_id : undefined);
  const observing =
    node.source.kind === 'builtin' && node.source.component === sessionHuddleTrigger.id;
  const binding = node.parameters.worktree;
  const worktree =
    binding?.kind === 'literal' && typeof binding.value === 'string' ? binding.value : undefined;
  return {
    worktrees:
      roots.data?.worktrees.map((root) => ({
        value: root.path,
        label: `${root.branch ?? 'Detached'} · ${root.path}`,
      })) ?? [],
    sessions:
      agents.data
        ?.filter(
          (agent) =>
            agent.project_id === session.project_id &&
            (observing
              ? agent.kind !== 'huddle'
              : agent.kind === 'agent' &&
                !['archived', 'exited', 'interrupted'].includes(agent.status)) &&
            (!worktree || agent.worktree_path === worktree),
        )
        .map((agent) => ({
          value: agent.id,
          label: `${agent.title ?? agent.agent_title ?? agent.agent_type ?? (agent.kind === 'terminal' ? 'Terminal' : 'Agent')} · ${agent.id.slice(0, 8)} · ${agent.worktree_path}`,
        })) ?? [],
    error: project.error?.message ?? roots.error?.message ?? agents.error?.message,
  };
}
