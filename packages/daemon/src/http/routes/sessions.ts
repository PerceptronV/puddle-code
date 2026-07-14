import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import {
  archiveRequestSchema,
  createSessionRequestSchema,
  migrateSessionRequestSchema,
  patchSessionRequestSchema,
  sessionStatusSchema,
  type Session,
  type SessionPortsResponse,
} from '@puddle/shared';
import type { PortScanner } from '../../ports/scanner.js';
import type { SessionService } from '../../sessions/service.js';
import { gitSummary } from '../../worktrees/inspect.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../validate.js';

export function sessionRoutes(deps: { service: SessionService; scanner: PortScanner }): Hono {
  return new Hono()
    .get('/', (c) => {
      const project = c.req.query('project');
      const statusRaw = c.req.query('status');
      const status = statusRaw !== undefined ? sessionStatusSchema.safeParse(statusRaw) : undefined;
      if (status && !status.success) {
        throw ApiError.badRequest('invalid_status', `unknown status '${statusRaw}'`);
      }
      return c.json(
        deps.service.list({
          project_id: project,
          status: status?.data,
        }),
      );
    })
    .post('/', async (c) => {
      const body = await parseBody(c, createSessionRequestSchema);
      return c.json(await deps.service.create(body), 201);
    })
    .get('/:id', async (c) => {
      const session = deps.service.get(c.req.param('id'));
      // Computed on read, single-session GET only (SPEC §6/§8): too
      // expensive to run per row on the list endpoint.
      const git_summary = existsSync(session.worktree_path)
        ? await gitSummary(session.worktree_path, session.base_branch)
        : null;
      return c.json<Session>({ ...session, git_summary });
    })
    .patch('/:id', async (c) => {
      const body = await parseBody(c, patchSessionRequestSchema);
      return c.json(deps.service.rename(c.req.param('id'), body.title));
    })
    .post('/:id/resume', async (c) => c.json(await deps.service.resume(c.req.param('id'))))
    .post('/:id/migrate', async (c) => {
      const body = await parseBody(c, migrateSessionRequestSchema);
      return c.json(await deps.service.migrate(c.req.param('id'), body.account_id));
    })
    .post('/:id/kill', async (c) => c.json(await deps.service.kill(c.req.param('id'))))
    .post('/:id/archive', async (c) => {
      const body = await parseBody(c, archiveRequestSchema);
      return c.json(await deps.service.archive(c.req.param('id'), body.force, body.delete_branch));
    })
    .get('/:id/ports', async (c) => {
      const id = c.req.param('id');
      deps.service.get(id); // 404 for an unknown session
      const ports = await deps.scanner.scan(id);
      return c.json<SessionPortsResponse>({ ports, scanned_at: new Date().toISOString() });
    });
}
