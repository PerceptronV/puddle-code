import { realpathSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';
import {
  createSessionRequestSchema,
  repoBranchesResponseSchema,
  repoWorktreesResponseSchema,
  sessionStatusSchema,
  type WsServerMessage,
} from '@puddle/shared';
import type { AppDeps } from '../http/app.js';
import { ApiError } from '../http/errors.js';
import { parseBody } from '../http/validate.js';

const denied = () =>
  new ApiError(403, 'profile_scope', 'This registration only accesses its profile');
const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Host-owned scope, fixed when the private control connection creates its lease. */
export class ProfileAccess {
  constructor(
    private readonly stores: Pick<
      NonNullable<AppDeps['api']>,
      'profiles' | 'projects' | 'sessions'
    >,
  ) {}

  project(profile: string, id: string): boolean {
    try {
      this.stores.profiles.get(profile);
      return this.stores.projects.get(id).profile_id === profile;
    } catch {
      return false;
    }
  }
  session(profile: string, id: string): boolean {
    try {
      return this.project(profile, this.stores.sessions.get(id).project_id);
    } catch {
      return false;
    }
  }
  event(profile: string, message: WsServerMessage): WsServerMessage | null {
    if ('session' in message)
      return message.session && this.session(profile, message.session) ? message : null;
    switch (message.t) {
      case 'authenticated':
      case 'error':
        return message;
      case 'account':
        return message.profile_id === profile ? message : null;
      case 'sessions-changed': {
        const project_ids = message.project_ids.filter((id) => this.project(profile, id));
        return project_ids.length ? { ...message, project_ids } : null;
      }
      case 'session-switched':
        return this.session(profile, message.source_session) &&
          this.session(profile, message.target_session) &&
          this.project(profile, message.target_project)
          ? message
          : null;
      // Unscoped notices and future event types must receive an explicit scope review.
      default:
        return null;
    }
  }
}

/** Fail closed for every route outside the profile's remote operation surface. */
export function profileAccessMiddleware(
  api: Pick<
    NonNullable<AppDeps['api']>,
    'profiles' | 'projects' | 'sessions' | 'accounts' | 'repos'
  > & { service: Pick<NonNullable<AppDeps['api']>['service'], 'list'> },
): MiddlewareHandler {
  const access = new ProfileAccess(api);
  return async (c, next) => {
    const profile = c.get('remoteProfile') as string | undefined;
    if (!profile) return next();
    const owner = api.profiles.get(profile);
    const path = c.req.path;
    const method = c.req.method;
    const project = c.req.query('project');
    if (c.req.query('profile') && c.req.query('profile') !== profile) throw denied();
    if (project && !access.project(profile, project)) throw denied();
    const projects = api.projects.list(profile);
    const repos = new Set(projects.map((row) => row.repo_id));
    const sessions = () => api.service.list({ profile_id: profile });
    if (method === 'GET') {
      if (path === '/api/profiles') return c.json([owner]);
      if (path === '/api/projects') return c.json(projects);
      if (path === '/api/accounts') return c.json(api.accounts.list(profile));
      if (path === '/api/repos')
        return c.json(
          api.repos
            .list()
            .filter((row) => repos.has(row.id))
            .map((row) => ({ ...row, orphan_worktrees: [] })),
        );
      if (path === '/api/sessions') {
        const raw = c.req.query('status');
        const status = raw === undefined ? undefined : sessionStatusSchema.safeParse(raw);
        if (status && !status.success)
          throw ApiError.badRequest('invalid_status', 'Unknown session status');
        return c.json(
          api.service.list({ profile_id: profile, project_id: project, status: status?.data }),
        );
      }
      if (/^\/api\/(version|host|config|agents)$/.test(path)) return next();
      const settings = /^\/api\/profiles\/([a-f0-9]{10})\/(settings|state)$/.exec(path);
      if (settings) {
        if (settings[1] !== profile) throw denied();
        return next();
      }
      const repo = /^\/api\/repos\/([0-9]+)\/(branches|worktrees)$/.exec(path);
      if (repo) {
        const id = Number(repo[1]);
        if (!repos.has(id)) throw denied();
        await next();
        if (!c.res.ok) return;
        // Git belongs to the shared repository; Puddle annotations belong to the profile.
        const own = sessions().filter((row) =>
          projects.some((p) => p.id === row.project_id && p.repo_id === id),
        );
        if (repo[2] === 'branches') {
          const result = repoBranchesResponseSchema.parse(await c.res.json());
          const titles = new Map(own.map((row) => [row.branch, row.title]));
          c.res = c.json({
            branches: result.branches.map((row) => ({
              ...row,
              is_session: titles.has(row.name),
              session_title: titles.get(row.name) ?? null,
            })),
          });
        } else {
          const result = repoWorktreesResponseSchema.parse(await c.res.json());
          const paths = new Set(own.map((row) => canonical(row.worktree_path)));
          c.res = c.json({
            worktrees: result.worktrees.filter(
              (row) => row.is_primary || paths.has(canonical(row.path)),
            ),
            orphan_branches: [],
          });
        }
        return;
      }
    }
    if (path === '/api/sessions' && method === 'POST') {
      const body = await parseBody(c, createSessionRequestSchema);
      if (!access.project(profile, body.project_id)) throw denied();
      if (body.account_id && api.accounts.get(body.account_id).profile_id !== profile)
        throw denied();
      if (body.join_worktree) {
        const repo = api.repos.get(api.projects.get(body.project_id).repo_id);
        const target = canonical(body.join_worktree);
        if (
          target !== canonical(repo.path) &&
          !sessions().some((row) => canonical(row.worktree_path) === target)
        )
          throw denied();
      }
      return next();
    }
    const projectRoute = /^\/api\/projects\/([a-f0-9]{10})(\/conversations\/refresh)?$/.exec(path);
    if (
      projectRoute &&
      ((method === 'GET' && !projectRoute[2]) || (method === 'POST' && projectRoute[2]))
    ) {
      if (!access.project(profile, projectRoute[1]!)) throw denied();
      return next();
    }
    const sessionRoute =
      /^\/api\/sessions\/([a-f0-9-]{36})(\/(resume|kill|archive|unarchive))?$/.exec(path);
    if (
      sessionRoute &&
      ((!sessionRoute[2] && (method === 'GET' || method === 'PATCH')) ||
        (sessionRoute[2] && method === 'POST'))
    ) {
      if (!access.session(profile, sessionRoute[1]!)) throw denied();
      return next();
    }
    const file =
      /^\/api\/worktrees\/([a-f0-9-]{36})\/(tree|file|resolve|preview-asset|paste|diff|git-status|git-repositories|index-file|git-original|file-at|log|show\/[a-f0-9]{4,40})$/.exec(
        path,
      );
    if (file && method === (file[2] === 'paste' ? 'POST' : 'GET')) {
      // Directory-only browsing retains the existing shared-OS-user filesystem access.
      const directoryRead =
        file[1] === '00000000-0000-0000-0000-000000000000' &&
        /^(tree|file|resolve|preview-asset)$/.test(file[2]!);
      if (!directoryRead && !access.session(profile, file[1]!)) throw denied();
      return next();
    }
    throw denied();
  };
}
