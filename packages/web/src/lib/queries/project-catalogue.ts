import {
  projectCatalogueSchema,
  projectSchema,
  repoWithOrphansSchema,
  sessionSchema,
  type Project,
  type ProjectCatalogue,
  type ProjectSessionCounts,
} from '@puddle/shared';
import { orderByDrag } from '../../features/workspace/sessions/session-order';
import { loadOrderedProjects } from '../../features/mobile/project-order';

export interface ProjectCatalogueView {
  projects: Project[];
  paths: Record<number, string>;
  counts: Record<string, ProjectSessionCounts>;
}

export function catalogueView(catalogue: ProjectCatalogue): ProjectCatalogueView {
  const projects = catalogue.projects.map((entry) => entry.project);
  return {
    projects: [...new Set(projects.map((project) => project.profile_id))].flatMap((profile) =>
      orderByDrag(
        projects.filter((project) => project.profile_id === profile),
        catalogue.project_order[profile] ?? [],
      ),
    ),
    paths: Object.fromEntries(
      catalogue.projects.map((entry) => [entry.project.repo_id, entry.repo_path]),
    ),
    counts: Object.fromEntries(
      catalogue.projects.map((entry) => [entry.project.id, entry.sessions]),
    ),
  };
}

/** Old hosts publish navigation first; only compact projections survive each supporting read. */
export async function loadProjectCatalogue(
  read: (path: string) => Promise<unknown>,
  compact: boolean,
  current: () => boolean,
  publish: (view: ProjectCatalogueView) => void,
): Promise<void> {
  if (compact) {
    const view = catalogueView(projectCatalogueSchema.parse(await read('/api/projects/catalogue')));
    if (current()) publish(view);
    return;
  }
  let view: ProjectCatalogueView = {
    projects: projectSchema.array().parse(await read('/api/projects')),
    paths: {},
    counts: {},
  };
  if (!current()) return;
  publish(view);
  const update = (patch: Partial<ProjectCatalogueView>) => {
    if (current()) {
      view = { ...view, ...patch };
      publish(view);
    }
  };
  await Promise.allSettled([
    read('/api/repos').then((value) =>
      update({
        paths: Object.fromEntries(
          repoWithOrphansSchema
            .array()
            .parse(value)
            .map((repo) => [repo.id, repo.path]),
        ),
      }),
    ),
    read('/api/sessions').then((value) => {
      const counts = Object.fromEntries(
        view.projects.map((project) => [
          project.id,
          { total: 0, running: 0, waiting_input: 0, interrupted: 0 },
        ]),
      );
      for (const session of sessionSchema.array().parse(value)) {
        const count = counts[session.project_id];
        if (!count || session.status === 'archived') continue;
        count.total++;
        if (
          session.status === 'running' ||
          session.status === 'waiting_input' ||
          session.status === 'interrupted'
        )
          count[session.status]++;
      }
      update({ counts });
    }),
    loadOrderedProjects(view.projects, read).then((projects) => update({ projects })),
  ]);
}
