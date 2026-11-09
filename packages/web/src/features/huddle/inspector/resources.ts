import { useQuery } from '@tanstack/react-query';
import {
  sessionHuddleTrigger,
  huddleHostTrigger,
  puddlangContextSchema,
  type HuddleNodeDefinition,
  type HuddleComponent,
  type Session,
} from '@puddle/shared';
import {
  useAccounts,
  useProjectDetail,
  useRepoWorktrees,
  useSessions,
} from '../../../lib/queries/queries';
import { api } from '../../../lib/transport/api';

export interface NodeResourceOptions {
  worktrees: Array<{ value: string; label: string }>;
  sessions: Array<{ value: string; label: string }>;
  projects: Array<{ value: string; label: string }>;
  providers: Array<{ value: string; label: string }>;
  accounts: Array<{ value: string; label: string }>;
  error?: string;
}
export function useNodeResourceOptions(
  session: Session,
  node: HuddleNodeDefinition,
  enabled: boolean,
  component?: HuddleComponent,
): NodeResourceOptions {
  const project = useProjectDetail(enabled ? session.project_id : undefined);
  const roots = useRepoWorktrees(enabled ? project.data?.project.repo_id : undefined);
  const agents = useSessions(enabled ? session.project_id : undefined);
  const spawning =
    enabled &&
    Object.values(component?.parameters ?? {}).some((parameter) =>
      ['account', 'agent', 'project'].includes(parameter.editor),
    );
  const profile = spawning ? project.data?.project.profile_id : undefined;
  const accounts = useAccounts(profile);
  const context = useQuery({
    queryKey: ['puddlang-context', profile],
    queryFn: async ({ signal }) =>
      puddlangContextSchema.parse(
        await api('GET', `/api/puddlang/${profile}/context`, undefined, signal),
      ),
    enabled: !!profile,
    retry: false,
  });
  const providers = context.data?.agents.filter((agent) => agent.scripted_turns) ?? [];
  const selected = Object.entries(component?.parameters ?? {}).flatMap(([name, parameter]) => {
    const binding = node.parameters[name];
    return parameter.editor === 'agent' &&
      binding?.kind === 'literal' &&
      typeof binding.value === 'string'
      ? [binding.value]
      : [];
  });
  const observing = huddleHostTrigger(node, component)?.id === sessionHuddleTrigger.id;
  const binding = node.parameters.worktree;
  const worktree =
    binding?.kind === 'literal' && typeof binding.value === 'string' ? binding.value : undefined;
  return {
    projects: project.data
      ? [{ value: project.data.project.id, label: project.data.project.name }]
      : [],
    providers: providers.map((agent) => ({ value: agent.id, label: agent.id })),
    accounts:
      accounts.data
        ?.filter(
          (account) =>
            account.profile_id === profile &&
            account.logged_in &&
            providers.some((provider) => provider.id === account.agent_type) &&
            (!selected.length || selected.includes(account.agent_type)),
        )
        .map((account) => ({
          value: String(account.id),
          label: `${account.label} · ${account.agent_type} · #${account.id}`,
        })) ?? [],
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
                (component?.lifecycle === 'resume'
                  ? ['exited', 'interrupted'].includes(agent.status)
                  : !['archived', 'exited', 'interrupted'].includes(agent.status))) &&
            (!worktree || agent.worktree_path === worktree),
        )
        .map((agent) => ({
          value: agent.id,
          label: `${agent.title ?? agent.agent_title ?? agent.agent_type ?? (agent.kind === 'terminal' ? 'Terminal' : 'Agent')} · ${agent.id.slice(0, 8)} · ${agent.worktree_path}`,
        })) ?? [],
    error:
      project.error?.message ??
      roots.error?.message ??
      agents.error?.message ??
      accounts.error?.message ??
      context.error?.message,
  };
}
