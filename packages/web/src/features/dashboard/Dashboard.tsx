import { useState } from 'react';
import { Archive, ChevronRight, FolderGit2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import {
  useProfileSettings,
  usePatchProfileSettings,
  useProjects,
  useRepos,
} from '../../lib/queries';
import { cn } from '../../lib/utils';
import { orderByDrag, reorderIds } from '../workspace/session-order';
import { useCurrentProfileId } from '../profile/profile-store';
import { NewProjectDialog } from './NewProjectDialog';
import { ProjectCard } from './ProjectCard';

/** The current profile's projects — creation lives in ⌘K and the empty state. */
export function Dashboard() {
  const profileId = useCurrentProfileId();
  const projects = useProjects(profileId ?? undefined);
  const repos = useRepos();
  const settings = useProfileSettings(profileId ?? undefined);
  const patchSettings = usePatchProfileSettings(profileId ?? '');
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const repoPath = (repoId: number) => repos.data?.find((r) => r.id === repoId)?.path;

  const all = projects.data ?? [];
  // New projects float to the top until dragged; archived ones drop out of the
  // grid into the disclosure below (SPEC §11).
  const order = settings.data?.projectOrder ?? [];
  const active = orderByDrag(
    all.filter((p) => !p.archived),
    order,
  );
  const archived = all.filter((p) => p.archived);

  const move = (id: string, before: string) => {
    if (id === before) return;
    patchSettings.mutate({
      projectOrder: reorderIds(
        active.map((p) => p.id),
        id,
        before,
      ),
    });
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      {all.length === 0 && (
        <div className="mt-24 flex flex-col items-center gap-6 text-center">
          <FolderGit2 className="size-8 text-fg-muted" />
          <p className="text-sm text-fg-secondary">
            No projects yet — press ⌘K or create one to get started.
          </p>
          <Button onClick={() => setCreating(true)}>New project</Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {active.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            repoPath={repoPath(project.repo_id)}
            draggable
            dragging={dragging === project.id}
            onDragStart={() => setDragging(project.id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragging && dragging !== project.id) move(dragging, project.id);
            }}
          />
        ))}
      </div>

      {archived.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-1.5 px-1 py-1.5 text-2xs uppercase tracking-wide text-fg-muted transition-colors hover:text-fg"
          >
            <ChevronRight
              className={cn('size-3 transition-transform', showArchived && 'rotate-90')}
            />
            <Archive className="size-3" />
            <span>Archived</span>
            <span className="tabular-nums">{archived.length}</span>
          </button>
          {showArchived && (
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {archived.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  repoPath={repoPath(project.repo_id)}
                  draggable={false}
                  dragging={false}
                  onDragStart={() => {}}
                  onDragEnd={() => {}}
                  onDragOver={() => {}}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {profileId !== null && (
        <NewProjectDialog profileId={profileId} open={creating} onOpenChange={setCreating} />
      )}
    </div>
  );
}
