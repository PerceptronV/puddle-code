import {
  huddleDefinitionSchema,
  huddleDocumentSchema,
  huddleLayoutSchema,
  sessionSchema,
} from '@puddle/shared';
import { profile, project, sessions } from '../../../src/dev/preview/data';
import { sourceFixture } from '../source/fixture';

/** One in-memory source shared by actual renderer pages; never connects to a host. */
export function huddleWindowBackend() {
  const id = 'e'.repeat(32),
    root = `.puddle/huddle/${id}/`;
  const session = sessionSchema.parse({
    ...sessions[0],
    id: '00000000-0000-4000-8000-000000000097',
    kind: 'huddle',
    huddle_id: id,
    agent_type: null,
    account_id: null,
    status: 'exited',
    title: 'Window huddle',
  });
  const definition = huddleDefinitionSchema.parse({
    format: 1,
    id,
    name: 'Window huddle',
    nodes: [
      { id: 'run', source: { kind: 'builtin', component: 'puddle.trigger.manual', version: 1 } },
      { id: 'result', source: { kind: 'builtin', component: 'puddle.readout.result', version: 1 } },
    ],
    edges: [
      { id: 'wire', from: { node: 'run', port: 'event' }, to: { node: 'result', port: 'value' } },
    ],
  });
  const document = huddleDocumentSchema.parse({
    definition,
    digest: 'a'.repeat(64),
    diagnostics: [],
    components: {},
  });
  const disk = new Map([[id, { content: JSON.stringify(definition), mtime: 1 }]]);
  const files = new Map([
    [
      root + 'layout.json',
      {
        content: JSON.stringify(
          huddleLayoutSchema.parse({
            format: 1,
            nodes: { run: { x: 0, y: 0 }, result: { x: 400, y: 200 } },
          }),
        ),
        mtime: 1,
      },
    ],
  ]);
  const source = sourceFixture(document, disk, files);
  const prefix = `/api/huddle/${profile.id}`;
  const requests: Array<{ method: string; path: string }> = [];
  return {
    session,
    root,
    requests,
    externalName(name: string) {
      const current = disk.get(id)!;
      disk.set(id, {
        content: JSON.stringify({ ...JSON.parse(current.content), name }),
        mtime: current.mtime + 1,
      });
    },
    name() {
      return JSON.parse(disk.get(id)!.content).name;
    },
    async request(method: string, path: string, body?: unknown) {
      requests.push({ method, path });
      const url = new URL(path, 'http://fixture');
      let response: Response | undefined;
      if (url.pathname === '/api/sessions') response = Response.json([...sessions, session]);
      else if (url.pathname === `/api/sessions/${session.id}`) response = Response.json(session);
      else if (url.pathname === `/api/projects/${project.id}` && method === 'GET')
        response = Response.json({ project, sessions: [...sessions, session] });
      else if (url.pathname === `${prefix}/definitions/${id}/source`)
        response = await source.request(method, body as Parameters<typeof source.request>[1]);
      else if (url.pathname === `${prefix}/definitions/${id}`) {
        await source.request('GET');
        response = Response.json(document);
      } else if (url.pathname === `${prefix}/sessions/${session.id}/runtime`)
        response = Response.json({ session_id: session.id, unresolved: false, owner: null });
      else if (url.pathname.startsWith(prefix))
        response = Response.json(
          { error: { code: 'unexpected', message: 'Unexpected huddle action' } },
          { status: 409 },
        );
      else if (url.pathname === `/api/worktrees/${session.id}/file`) {
        const path = url.searchParams.get('path')!;
        const file = path === root + 'huddle.json' ? disk.get(id) : files.get(path);
        response = file
          ? Response.json({ path, content: file.content, mtime_ms: file.mtime, binary: false })
          : Response.json(
              { error: { code: 'not_found', message: 'Missing fixture file' } },
              { status: 404 },
            );
      }
      return response ? { status: response.status, body: await response.json() } : null;
    },
  };
}
