import { applyTheme } from '../../src/lib/appearance/theme';
import { profileStore } from '../../src/features/profile/profile-store';
import { mountWorkspaceFixture } from '../dev/workspace-fixture';
import {
  browserTransport,
  installBrowserTransport,
} from '../../src/lib/transport/browser-transport';
import {
  huddleDefinitionSchema,
  huddleDocumentSchema,
  huddleComponentSchema,
  huddleAgentTemplateFiles,
  huddleLayoutSchema,
  sessionSchema,
} from '@puddle/shared';
import { profile, project, sessions } from '../../src/dev/preview/data';
import { huddleRuntimeFixture } from './runtime';

const fixture = mountWorkspaceFixture();
if (new URLSearchParams(location.search).has('agent-templates')) {
  for (const [index, title] of ['Coder', 'Reviewer'].entries())
    fixture.addSession(
      sessionSchema.parse({
        ...sessions[0],
        id: `00000000-0000-4000-8000-00000000000${index + 5}`,
        title,
        kind: 'agent',
        agent_type: 'claude',
        status: 'waiting_input',
      }),
    );
}
const transport = browserTransport()!;
installBrowserTransport(null);
profileStore.set(profile.id);
const messages: unknown[] = [];
const requests: Array<{ method: string; path: string; body?: unknown }> = [];
// Local transport shape with in-memory HTTP and WS; never contacts a daemon.
window.WebSocket = class extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  constructor() {
    super();
    queueMicrotask(() => {
      this.dispatchEvent(new Event('open'));
      this.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify({ t: 'authenticated' }) }),
      );
    });
  }
  send(value: string) {
    messages.push(JSON.parse(value));
  }
  close() {}
} as unknown as typeof WebSocket;
const savedId = 'a'.repeat(32);
const createdId = 'b'.repeat(32);
const document = huddleDocumentSchema.parse({
  digest: 'c'.repeat(64),
  definition: huddleDefinitionSchema.parse({
    format: 1,
    id: savedId,
    name: 'Review graph',
    variables: { targetWorktree: { schema: { type: 'string' }, editor: 'worktree' } },
    nodes: [
      { id: 'run', source: { kind: 'builtin', component: 'puddle.trigger.manual', version: 1 } },
      { id: 'result', source: { kind: 'builtin', component: 'puddle.readout.result', version: 1 } },
    ],
    edges: [
      {
        id: 'result-edge',
        from: { node: 'run', port: 'event' },
        to: { node: 'result', port: 'value' },
      },
    ],
  }),
  components: {
    run: huddleComponentSchema.parse({
      format: 1,
      id: 'puddle.trigger.manual',
      version: 1,
      category: 'trigger',
      title: 'Run',
      outputs: { event: { schema: {}, emission: 'event' } },
    }),
    result: huddleComponentSchema.parse({
      format: 1,
      id: 'puddle.readout.result',
      version: 1,
      category: 'readout',
      title: 'Result',
      inputs: { value: { schema: {} } },
    }),
  },
  diagnostics: [],
});
const saved = sessionSchema.parse({
  ...sessions[0],
  id: '00000000-0000-4000-8000-000000000003',
  kind: 'huddle',
  huddle_id: savedId,
  status: 'exited',
  title: 'Review graph',
  account_id: null,
  agent_type: null,
});
const reviewer = huddleComponentSchema.parse({
  format: 1,
  id: 'example.reviewer',
  version: 1,
  category: 'script',
  title: 'Reviewer',
  entry: 'run.ts',
  inputs: { request: { schema: {} } },
  outputs: { reply: { schema: {} } },
  capabilities: ['sessions'],
  parameters: {
    prompt: { title: 'Prompt', schema: { type: 'string' }, editor: 'prompt' },
    worktree: { title: 'Worktree', schema: { type: 'string' }, editor: 'worktree' },
    enabled: { title: 'Enabled', schema: { type: 'boolean' }, editor: 'boolean' },
    options: { title: 'Options', schema: { type: 'object' }, editor: 'json', required: false },
  },
});
let created: typeof saved | undefined;
let blank: typeof document | undefined;
const disk = new Map<string, { content: string; mtime: number }>([
  [savedId, { content: JSON.stringify(document.definition, null, 2), mtime: 1 }],
]);
const components = new Map<string, { content: string; mtime: number }>([
  [
    `.puddle/huddle/${savedId}/nodes/review/node.json`,
    { content: JSON.stringify(reviewer), mtime: 1 },
  ],
]);
let available = true;
const runtime = huddleRuntimeFixture(() => document);
let executionSupported = !new URLSearchParams(location.search).has('old-execution');
let revision = 10;
const changedRevision = () => {
  document.digest = (++revision).toString(16).padStart(64, '0');
};
let opened = false;
let failLayoutRead = false;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/frontend/'))
    return nativeFetch(input, init);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const path = url.pathname;
  requests.push({ method, path, body });
  const prefix = `/api/huddle/${profile.id}`;
  if (
    path === '/api/version' &&
    (!executionSupported ||
      new URLSearchParams(location.search).has('old-templates') ||
      new URLSearchParams(location.search).has('old-layout'))
  ) {
    const version = await transport.request(method, path, body).then((response) => response.json());
    return Response.json({
      ...version,
      protocol: {
        major: 28,
        minor: !executionSupported
          ? 1
          : new URLSearchParams(location.search).has('old-layout')
            ? 3
            : 2,
      },
    });
  }
  const execution = path.match(new RegExp(`^${prefix}/sessions/([^/]+)/([^/]+)$`));
  if (execution) return runtime.request(execution[1]!, execution[2]!, body);
  if (path === `${prefix}/availability`)
    return Response.json(
      available
        ? { available: true, build: 'fixture', lifetime: 'service' }
        : { available: false, reason: 'Install a runtime with huddle support' },
    );
  if (path === `${prefix}/definitions` && method === 'GET')
    return Response.json(
      [document, ...(blank ? [blank] : [])].map((item) => ({
        id: item.definition.id,
        name: item.definition.name,
        digest: item.digest,
        diagnostics: [],
      })),
    );
  if (path === `${prefix}/definitions/${savedId}`) return Response.json(document);
  if (path === `${prefix}/definitions/${createdId}`) return Response.json(blank);
  const install = path.match(new RegExp(`^${prefix}/definitions/([^/]+)/components$`));
  if (install && method === 'POST') {
    const template = huddleAgentTemplateFiles(body.template);
    const root = `.puddle/huddle/${install[1]}/nodes/${body.component}`;
    for (const [name, content] of Object.entries(template.files))
      components.set(`${root}/${name}`, { content, mtime: 1 });
    return Response.json({
      manifest: `nodes/${body.component}/node.json`,
      component: template.component,
    });
  }
  if (path === `${prefix}/definitions` && method === 'POST') {
    if (!available)
      return Response.json(
        { error: { code: 'unsupported', message: 'No supporting runtime' } },
        { status: 409 },
      );
    created = sessionSchema.parse({
      ...saved,
      id: '00000000-0000-4000-8000-000000000004',
      huddle_id: createdId,
      title: body.name,
    });
    blank = huddleDocumentSchema.parse({
      ...document,
      definition: huddleDefinitionSchema.parse({
        format: 1,
        id: createdId,
        name: body.name,
        nodes: [],
        edges: [],
      }),
      components: {},
    });
    disk.set(createdId, { content: JSON.stringify(blank.definition, null, 2), mtime: 1 });
    fixture.addSession(created);
    return Response.json({ created: true, session: created, document: blank }, { status: 201 });
  }
  if (path === `${prefix}/open`) {
    if (body.huddle_id === createdId)
      return Response.json({ created: false, session: created, document: blank });
    if (!opened) {
      fixture.addSession(saved);
      opened = true;
    }
    return Response.json({ created: false, session: saved, document });
  }
  if (path.endsWith('/file') && url.searchParams.get('path')?.startsWith('.puddle/huddle/')) {
    const filename = url.searchParams.get('path')!.replaceAll('/./', '/');
    if (method === 'GET' && filename.endsWith('/layout.json') && failLayoutRead)
      return Response.json(
        { error: { code: 'read_failed', message: 'Layout read failed' } },
        { status: 500 },
      );
    const id = filename.split('/')[2]!;
    const definition = filename === `.puddle/huddle/${id}/huddle.json`;
    let file = definition ? disk.get(id) : components.get(filename);
    const creating =
      !file &&
      method === 'PUT' &&
      body.expected_mtime_ms === -1 &&
      filename.endsWith('/layout.json');
    if (creating) {
      file = { content: '', mtime: 1 };
      components.set(filename, file);
    }
    if (!file)
      return Response.json(
        { error: { code: 'not_found', message: 'File not found' } },
        { status: 404 },
      );
    if (method === 'PUT') {
      if (
        !creating &&
        body.expected_mtime_ms !== undefined &&
        body.expected_mtime_ms !== file.mtime
      )
        return Response.json(
          { error: { code: 'stale_file', message: 'Definition changed on disk' } },
          { status: 409 },
        );
      file.content = body.content;
      file.mtime++;
      if (definition) {
        const target = id === savedId ? document : blank!;
        target.definition = huddleDefinitionSchema.parse(JSON.parse(file.content));
        target.digest = (++revision).toString(16).padStart(64, '0');
        for (const node of target.definition.nodes) {
          if (node.source.kind === 'local') {
            const component = components.get(`.puddle/huddle/${id}/${node.source.manifest}`);
            if (component)
              target.components[node.id] = huddleComponentSchema.parse(
                JSON.parse(component.content),
              );
          }
        }
      }
      if (filename.endsWith('/layout.json')) {
        const target = id === savedId ? document : blank!;
        const parsed = huddleLayoutSchema.safeParse(JSON.parse(file.content));
        target.layout = parsed.success ? parsed.data : undefined;
        changedRevision();
      }
    }
    return Response.json({
      path: url.searchParams.get('path'),
      content: file.content,
      binary: false,
      size: file.content.length,
      mtime_ms: file.mtime,
    });
  }
  return transport.request(method, url.pathname + url.search, body);
};
Object.assign(window, {
  huddleFixture: {
    ...fixture,
    theme: applyTheme,
    requests,
    messages,
    saved: saved.id,
    project: project.id,
    source: () => JSON.parse(disk.get(savedId)!.content),
    componentFiles: () => Object.fromEntries(components),
    layout: () =>
      JSON.parse(components.get(`.puddle/huddle/${savedId}/layout.json`)?.content ?? 'null'),
    failLayoutRead: (value: boolean) => {
      failLayoutRead = value;
    },
    externalLayout: (nodes: Record<string, { x: number; y: number }>) => {
      const filename = `.puddle/huddle/${savedId}/layout.json`;
      const previous = components.get(filename);
      document.layout = huddleLayoutSchema.parse({ format: 1, nodes });
      components.set(filename, {
        content: JSON.stringify(document.layout),
        mtime: (previous?.mtime ?? 0) + 1,
      });
      changedRevision();
    },
    externalEdit: (name: string) => {
      const file = disk.get(savedId)!;
      const value = JSON.parse(file.content);
      value.name = name;
      file.content = JSON.stringify(value, null, 2);
      file.mtime++;
      document.definition = huddleDefinitionSchema.parse(value);
      changedRevision();
    },
    available: (value: boolean) => {
      available = value;
    },
    runtime,
    executionSupported: (value: boolean) => {
      executionSupported = value;
    },
    changedRevision,
  },
});
