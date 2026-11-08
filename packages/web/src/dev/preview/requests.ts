import {
  config,
  files,
  originalFiles,
  modifiedTimes,
  profile,
  project,
  repo,
  settings,
  sessions,
  state,
  tree,
  version,
} from './data';
import { previewCollection } from './collections';
import { patchProjectRequestSchema } from '@puddle/shared';

const json = (value: unknown) => Response.json(value);
const unavailable = () =>
  Response.json(
    {
      error: {
        code: 'preview_unavailable',
        message: 'This action needs a daemon and is unavailable in the UI preview.',
      },
    },
    { status: 501 },
  );

/** All preview requests end here. Unimplemented actions never reach a host. */
export async function previewRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(path, 'http://preview');
  const route = url.pathname;
  const patch = typeof body === 'object' && body !== null ? body : {};
  const collection = previewCollection(method, route, patch);
  if (collection) return collection;
  if (route === `/api/projects/${project.id}` && method === 'PATCH') {
    Object.assign(project, patchProjectRequestSchema.parse(patch));
    return json(project);
  }
  if (route === `/api/profiles/${profile.id}` && method === 'PATCH') {
    Object.assign(profile, patch);
    return json(profile);
  }
  if (route === `/api/profiles/${profile.id}/settings` && ['GET', 'PATCH'].includes(method)) {
    if (method === 'PATCH') Object.assign(settings, patch);
    return json(settings);
  }
  if (route === `/api/profiles/${profile.id}/state` && ['GET', 'PUT'].includes(method)) {
    if (method === 'PUT') Object.assign(state, patch);
    return json(state);
  }
  if (route === '/api/config' && ['GET', 'PATCH'].includes(method)) {
    if (method === 'PATCH') Object.assign(config, patch);
    return json(config);
  }
  if (/^\/api\/worktrees\/[^/]+\/file$/.test(route)) {
    const name = url.searchParams.get('path') ?? '';
    if (
      method === 'PUT' &&
      'content' in patch &&
      typeof patch.content === 'string' &&
      files.has(name)
    ) {
      files.set(name, patch.content);
      modifiedTimes.set(name, (modifiedTimes.get(name) ?? 0) + 1);
    } else if (method !== 'GET') return unavailable();
    const content = files.get(name);
    if (content === undefined)
      return Response.json(
        { error: { code: 'not_found', message: 'No such sample file' } },
        { status: 404 },
      );
    return json({
      path: name,
      content,
      binary: false,
      size: content.length,
      mtime_ms: modifiedTimes.get(name),
    });
  }
  if (method !== 'GET') return unavailable();
  switch (route) {
    case '/frontend/local-sync':
      return new Response(null, { status: 404 });
    case '/api/release-notes':
      return json({ releases: [] });
    case '/api/profiles':
      return json([profile]);
    case '/api/projects':
      return json([project]);
    case `/api/projects/${project.id}`:
      return json({ project, sessions });
    case '/api/repos':
      return json([repo]);
    case '/api/version':
      return json(version);
    case '/api/host':
      return json({
        username: 'preview',
        hostname: 'UI preview · sample data',
        displayName: config.displayName,
        home: '/preview',
      });
    case '/api/sessions':
      return json(sessions);
    case '/api/accounts':
    case '/api/agents':
    case '/api/scratchpad':
    case '/api/layouts':
      return json([]);
    case '/api/compilation/capabilities':
      return json({ providers: [] });
    case '/api/notebooks/kernels':
      return json({ kernels: [] });
    case '/api/repos/1/branches':
      return json({ branches: [{ name: 'main', is_session: false, session_title: null }] });
    case '/api/repos/1/worktrees':
      return json({
        worktrees: [{ path: repo.path, branch: 'main', is_primary: true }],
        orphan_branches: [],
      });
  }
  if (/^\/api\/worktrees\/[^/]+\//.test(route)) {
    const name = url.searchParams.get('path') ?? '';
    if (route.endsWith('/tree')) return json(tree(name));
    if (route.endsWith('/preview-asset') && name === 'examples/preview.pdf')
      return json({ mime: 'application/pdf', data: btoa(files.get(name)!) });
    if (route.endsWith('/search')) {
      const query = url.searchParams.get('q') ?? '';
      const normalise = (text: string) =>
        url.searchParams.get('case') === 'true' ? text : text.toLowerCase();
      const matches = (text: string) => normalise(text).includes(normalise(query));
      const searchable = [...files].filter(
        ([path]) => !path.endsWith('.pdf') && !path.startsWith('node_modules/'),
      );
      return json({
        query,
        files: searchable.filter(([path]) => matches(path)).map(([path]) => path),
        content: searchable.flatMap(([path, text]) => {
          const found = text
            .split('\n')
            .flatMap((line, index) => (matches(line) ? [{ line: index + 1, text: line }] : []));
          return found.length ? [{ path, matches: found }] : [];
        }),
        truncated: false,
      });
    }
    if (route.endsWith('/git-repositories'))
      return json({
        repositories: [
          {
            root: repo.path,
            relative_path: '.',
            name: 'puddle',
            owning: true,
            submodule: false,
            initialised: true,
            head: '0000000000000000000000000000000000000000',
            branch: 'main',
            detached: false,
            upstream: null,
            ahead: 0,
            behind: 0,
            has_remote: false,
            staged: [],
            unstaged: [{ path: 'packages/web/src/App.tsx', status: 'modified', old_path: null }],
            conflicts: [],
          },
        ],
        entries: [{ path: 'packages/web/src/App.tsx', status: 'modified' }],
      });
    if (route.endsWith('/diff'))
      return json({
        against: 'HEAD',
        base_ref: 'main',
        entries: [{ path: 'packages/web/src/App.tsx', status: 'modified', old_path: null }],
      });
    if (route.endsWith('/file-at') || route.endsWith('/index-file'))
      return json({
        path: name,
        content: originalFiles.get(name) ?? null,
        binary: false,
        exists: originalFiles.has(name),
      });

    if (route.endsWith('/git-status'))
      return json({
        entries: [
          { path: 'node_modules/', status: 'ignored' },
          { path: 'packages/web/src/App.tsx', status: 'modified' },
        ],
      });
    if (route.endsWith('/git-original'))
      return json({
        path: name,
        repository: repo.path,
        repository_path: name,
        head: null,
        content: originalFiles.get(name) ?? null,
        binary: false,
        exists: files.has(name),
        tracked: true,
        ignored: false,
      });
    if (route.endsWith('/log')) return json({ commits: [], has_more: false });
  }
  console.debug('Preview has no fixture:', method, route);
  return unavailable();
}
