import { Hono } from 'hono';
import {
  archiveRequestSchema,
  createProjectRequestSchema,
  type ProjectDetail,
} from '@puddle/shared';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { ProjectStore } from '../../db/stores/projects.js';
import type { RepoStore } from '../../db/stores/repos.js';
import type { SessionService } from '../../sessions/service.js';
import type { WorktreeManager } from '../../worktrees/manager.js';
import { idParam, parseBody } from '../validate.js';

export interface ProjectRouteDeps {
  projects: ProjectStore;
  profiles: ProfileStore;
  repos: RepoStore;
  service: SessionService;
  worktrees: WorktreeManager;
}

export function projectRoutes(deps: ProjectRouteDeps): Hono {
  return new Hono()
    .get('/', (c) => {
      const profile = c.req.query('profile');
      return c.json(deps.projects.list(profile !== undefined ? Number(profile) : undefined));
    })
    .post('/', async (c) => {
      const body = await parseBody(c, createProjectRequestSchema);
      deps.profiles.get(body.profile_id);
      deps.repos.get(body.repo_id);
      return c.json(deps.projects.create(body), 201);
    })
    .get('/:id', (c) => {
      const project = deps.projects.get(idParam(c));
      // Fetch-on-project-open (SPEC §4): fire-and-forget, never blocks the UI.
      const repo = deps.repos.get(project.repo_id);
      void deps.worktrees
        .fetchRepo(repo)
        .catch((e) => console.warn(`open-fetch failed for ${repo.path}: ${(e as Error).message}`));
      return c.json<ProjectDetail>({
        project,
        sessions: deps.service.list({ project_id: project.id }),
      });
    })
    .post('/:id/archive', async (c) => {
      const body = await parseBody(c, archiveRequestSchema);
      await deps.service.archiveProject(idParam(c), body.force);
      return c.body(null, 204);
    });
}
