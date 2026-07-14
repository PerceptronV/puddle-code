import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { FolderGit2, Plus } from 'lucide-react';
import type { SessionStatus } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { Label } from '../../components/ui/label';
import { useProfiles, useProjects, useRepos, useSessions } from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';
import { NewProjectDialog } from './NewProjectDialog';

const COUNTED: Array<{ status: SessionStatus; colour: string }> = [
  { status: 'running', colour: 'bg-running' },
  { status: 'waiting_input', colour: 'bg-waiting' },
  { status: 'interrupted', colour: 'bg-interrupted' },
];

function SessionCounts({ projectId }: { projectId: number }) {
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

/** Project dashboard (SPEC §11): the current profile's projects, or everyone's. */
export function Dashboard() {
  const profileId = useCurrentProfileId();
  const [everyone, setEveryone] = useState(false);
  const projects = useProjects(everyone ? undefined : (profileId ?? undefined));
  const profiles = useProfiles();
  const repos = useRepos();
  const [creating, setCreating] = useState(false);

  const repoPath = (repoId: number) => repos.data?.find((r) => r.id === repoId)?.path;
  const profileName = (id: number) => profiles.data?.find((p) => p.id === id)?.name;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-fg">Projects</h1>
        <div className="ml-auto flex items-center gap-2">
          <Switch id="everyone" checked={everyone} onCheckedChange={setEveryone} />
          <Label htmlFor="everyone">Everyone</Label>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          New project
        </Button>
      </div>

      {projects.data?.length === 0 && (
        <div className="mt-16 flex flex-col items-center gap-2 text-center">
          <FolderGit2 className="size-8 text-fg-muted" />
          <p className="text-sm text-fg-secondary">
            No projects yet — press ⌘K or create one to get started.
          </p>
          <Button className="mt-2" onClick={() => setCreating(true)}>
            <Plus />
            New project
          </Button>
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {projects.data?.map((project) => {
          const foreign = project.profile_id !== profileId;
          return (
            <Link
              key={project.id}
              to={`/project/${project.id}`}
              className="group rounded-lg bg-surface p-4 transition-colors hover:bg-elevated"
            >
              <div className="flex items-baseline gap-2">
                <h2 className="truncate text-base font-semibold text-fg group-hover:text-accent">
                  {project.name}
                </h2>
                {(everyone || foreign) && (
                  <span className="ml-auto shrink-0 font-mono text-2xs text-fg-muted">
                    {profileName(project.profile_id) ?? `profile ${project.profile_id}`}
                  </span>
                )}
              </div>
              <p className="mt-1 truncate font-mono text-2xs text-fg-muted">
                {repoPath(project.repo_id) ?? '…'}
              </p>
              <div className="mt-3">
                <SessionCounts projectId={project.id} />
              </div>
            </Link>
          );
        })}
      </div>

      {profileId !== null && (
        <NewProjectDialog profileId={profileId} open={creating} onOpenChange={setCreating} />
      )}
    </div>
  );
}
