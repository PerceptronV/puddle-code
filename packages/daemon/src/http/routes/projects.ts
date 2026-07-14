import { Hono } from 'hono';
import {
  archiveRequestSchema,
  createProjectRequestSchema,
  putProjectStateRequestSchema,
  type ProjectDetail,
} from '@puddle/shared';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { ProjectStateStore } from '../../db/stores/project-states.js';
import type { ProjectStore } from '../../db/stores/projects.js';
import type { RepoStore } from '../../db/stores/repos.js';
import type { SessionService } from '../../sessions/service.js';
import type { WorktreeManager } from '../../worktrees/manager.js';
import { ApiError } from '../errors.js';
import { idParam, parseBody } from '../validate.js';

export interface ProjectRouteDeps {
  projects: ProjectStore;
  projectStates: ProjectStateStore;
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
    })
    .get('/:id/state', (c) => {
      const project = deps.projects.get(idParam(c));
      const client = c.req.query('client');
      if (!client) {
        throw ApiError.badRequest('missing_client', `query parameter 'client' is required`);
      }
      // The client's own row wins; a new client seeds from the project's
      // most recent snapshot (SPEC §11 reload semantics).
      const state =
        deps.projectStates.get(project.id, client) ?? deps.projectStates.latest(project.id);
      if (!state)
        throw new ApiError(404, 'no_state', `project ${project.id} has no saved ui state`);
      return c.json(state);
    })
    .put('/:id/state', async (c) => {
      const project = deps.projects.get(idParam(c));
      const client = c.req.query('client');
      if (!client) {
        throw ApiError.badRequest('missing_client', `query parameter 'client' is required`);
      }
      const body = await parseBody(c, putProjectStateRequestSchema);
      return c.json(deps.projectStates.put(project.id, client, body.ui_state));
    });
}
