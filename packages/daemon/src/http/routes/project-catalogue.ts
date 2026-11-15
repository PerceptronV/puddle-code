import type { ProjectCatalogue } from '@puddle/shared';
import type { ProjectRouteDeps } from './projects.js';

/** One bounded-by-project-count projection; no worktree scanning or session-list serialisation. */
export function projectCatalogue(
  deps: Pick<ProjectRouteDeps, 'projects' | 'profiles' | 'repos' | 'service'>,
  profile?: string,
): ProjectCatalogue {
  const projects = deps.projects.list(profile);
  const counts = deps.service.projectSessionCounts(profile);
  const paths = new Map<number, string>();
  const project_order: Record<string, string[]> = {};
  for (const id of new Set(projects.map((project) => project.profile_id))) {
    const own = new Set(
      projects.filter((project) => project.profile_id === id).map((project) => project.id),
    );
    project_order[id] = (deps.profiles.getSettings(id).projectOrder ?? []).filter((id) =>
      own.has(id),
    );
  }
  return {
    projects: projects.map((project) => {
      if (!paths.has(project.repo_id))
        paths.set(project.repo_id, deps.repos.get(project.repo_id).path);
      return {
        project,
        repo_path: paths.get(project.repo_id)!,
        sessions: counts.get(project.id) ?? {
          total: 0,
          running: 0,
          waiting_input: 0,
          interrupted: 0,
        },
      };
    }),
    project_order,
  };
}
