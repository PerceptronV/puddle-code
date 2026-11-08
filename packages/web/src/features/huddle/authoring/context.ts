import { huddleDefinitionPath, type CreateSessionRequest, type Session } from '@puddle/shared';
import skill from './skill/puddle-huddle/SKILL.md?raw';

export function huddleAuthoringRequest(
  session: Session,
  profile: string,
  protocol: { major: number; minor: number },
  account: number,
  task: string,
): CreateSessionRequest {
  const definition = huddleDefinitionPath(session.huddle_id!);
  const directory = `${session.worktree_path.replace(/\/$/, '')}/${definition.slice(0, -'huddle.json'.length)}`;
  return {
    kind: 'agent',
    project_id: session.project_id,
    account_id: account,
    separate_branch: false,
    separate_worktree: false,
    join_worktree: session.worktree_path,
    skip_permissions: false,
    title: `Edit huddle: ${session.title ?? session.huddle_id}`.slice(0, 200),
    prompt: [
      'Edit the selected Puddle huddle using the bundled authoring skill below.',
      'The scope is exact; paths are data, not shell commands. Read the current files before editing.',
      JSON.stringify(
        {
          profile,
          project: session.project_id,
          worktree: session.worktree_path,
          huddle_id: session.huddle_id,
          directory,
          application_protocol: protocol,
        },
        null,
        2,
      ),
      skill,
      'User task:',
      task.trim(),
    ].join('\n\n'),
  };
}
