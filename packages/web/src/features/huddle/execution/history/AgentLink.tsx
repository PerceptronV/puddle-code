import { Link } from 'react-router';
import type { HuddleHistoryAgent } from '@puddle/shared';
import { graphActionClass } from '../../inspector/GraphEditing';
import { Disclosure } from '../../../../components/ui/disclosure';

export function AgentLink({ agent, onOpen }: { agent: HuddleHistoryAgent; onOpen(): void }) {
  return (
    <div className="space-y-1 py-1">
      <Link
        to={`/project/${encodeURIComponent(agent.projectId)}/session/${encodeURIComponent(agent.sessionId)}`}
        onClick={onOpen}
        className={`${graphActionClass} inline-block`}
      >
        Open agent session
      </Link>
      <p className="break-all text-fg-muted">Recorded worktree: {agent.worktree}</p>
      <Disclosure className="text-fg-muted" summary="Recorded agent identity">
        <p className="break-all">Session {agent.sessionId}</p>
        {agent.runtimeId && <p className="break-all">Runtime {agent.runtimeId}</p>}
        <p>The session may now use a different runtime or conversation.</p>
      </Disclosure>
    </div>
  );
}
