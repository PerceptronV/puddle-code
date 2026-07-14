import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { FolderGit2 } from 'lucide-react';
import type { SessionStatus } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { useProjects, useRepos, useSessions } from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';
import { NewProjectDialog } from './NewProjectDialog';

const COUNTED: Array<{ status: SessionStatus; colour: string }> = [
  { status: 'running', colour: 'bg-running' },
  { status: 'waiting_input', colour: 'bg-waiting' },
  { status: 'interrupted', colour: 'bg-interrupted' },
];

function SessionCounts({ projectId }: { projectId: string }) {
  const sessions = useSessions(projectId);
  const counts = useMemo(() => {
    const byStatus = new Map<SessionStatus, number>();
    for (const session of sessions.data ?? []) {
      byStatus.set(session.status, (byStatus.get(session.status) ?? 0) + 1);
    }
    return byStatus;
  }, [sessions.data]);

  const active = (sessions.data ?? []).filter((s) => s.status !== 'archived').length;
  return (
    <div className="flex items-center gap-3 text-2xs text-fg-muted tabular-nums">
      <span>
        {active} session{active === 1 ? '' : 's'}
      </span>
      {COUNTED.map(({ status, colour }) => {
        const count = counts.get(status) ?? 0;
        if (count === 0) return null;
        return (
          <span key={status} className="flex items-center gap-1">
            <span className={`size-1.5 rounded-full ${colour}`} />
            {count} {status.replace('_', ' ')}
          </span>
        );
      })}
    </div>
  );
}

/** The current profile's projects — creation lives in ⌘K and the empty state. */
export function Dashboard() {
  const profileId = useCurrentProfileId();
  const projects = useProjects(profileId ?? undefined);
  const repos = useRepos();
  const [creating, setCreating] = useState(false);

  const repoPath = (repoId: number) => repos.data?.find((r) => r.id === repoId)?.path;

  return (
    <div className="mx-auto max-w-4xl p-6">
      {projects.data?.length === 0 && (
        <div className="mt-24 flex flex-col items-center gap-6 text-center">
          <FolderGit2 className="size-8 text-fg-muted" />
          <p className="text-sm text-fg-secondary">
            No projects yet — press ⌘K or create one to get started.
          </p>
          <Button onClick={() => setCreating(true)}>New project</Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {projects.data?.map((project) => (
          <Link
            key={project.id}
            to={`/project/${project.id}`}
            className="group rounded-lg bg-surface p-4 transition-colors hover:bg-elevated"
          >
            <h2 className="truncate text-base font-semibold text-fg group-hover:text-accent">
              {project.name}
            </h2>
            <p className="mt-1 truncate font-mono text-2xs text-fg-muted">
              {repoPath(project.repo_id) ?? '…'}
            </p>
            <div className="mt-3">
              <SessionCounts projectId={project.id} />
            </div>
          </Link>
        ))}
      </div>

      {profileId !== null && (
        <NewProjectDialog profileId={profileId} open={creating} onOpenChange={setCreating} />
      )}
    </div>
  );
}
