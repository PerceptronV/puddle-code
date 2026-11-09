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
  huddleTemplateFiles,
  huddleStarterFiles,
  huddleLayoutSchema,
  sessionSchema,
} from '@puddle/shared';
import { profile, project, sessions } from '../../src/dev/preview/data';
import { huddleRuntimeFixture } from './runtime';
import { largeGraph } from './canvas/large-graph';
import { retainedHistoryFixture } from './history/fixture';
import { sourceFixture } from './source/fixture';

const fixture = mountWorkspaceFixture({
  restore: new URLSearchParams(location.search).has('view-state'),
  toasts: new URLSearchParams(location.search).has('source-saves'),
});
if (new URLSearchParams(location.search).has('session-triggers')) {
  fixture.addSession(
    sessionSchema.parse({
      ...sessions[0],
      id: '00000000-0000-4000-8000-000000000009',
      title: 'Archived terminal',
      kind: 'terminal',
      agent_type: null,
      status: 'archived',
    }),
  );
}
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
const copiedId = 'd'.repeat(32);
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
if (new URLSearchParams(location.search).has('large-graph'))
  Object.assign(document, largeGraph(document));
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
let copied: typeof document | undefined;
const disk = new Map<string, { content: string; mtime: number }>([
  [savedId, { content: JSON.stringify(document.definition, null, 2), mtime: 1 }],
]);
const components = new Map<string, { content: string; mtime: number }>([
  [
    `.puddle/huddle/${savedId}/nodes/review/node.json`,
    { content: JSON.stringify(reviewer), mtime: 1 },
  ],
]);
if (document.layout)
  components.set(`.puddle/huddle/${savedId}/layout.json`, {
    content: JSON.stringify(document.layout),
    mtime: 1,
  });
if (new URLSearchParams(location.search).has('large-graph'))
  components.set(`.puddle/huddle/${savedId}/nodes/fixture/node.json`, {
    content: JSON.stringify(document.components.n0),
    mtime: 1,
  });
components.set(`.puddle/huddle/${savedId}/nodes/review/run.ts`, {
  content: '// initial script',
  mtime: 1,
});
const source = sourceFixture(document, disk, components);
const retainedHistory = retainedHistoryFixture({
  sessionId: '00000000-0000-4000-8000-000000000005',
  projectId: project.id,
  worktree: '/fixture/recorded-worktree',
  runtimeId: '88888888-8888-4888-8888-888888888888',
});
// Existing fixture scripts retain explicit pre-source-save host coverage.
// Modern captured saves use ?source-saves and real computed capture hashes.
const capturedSaves = ['source-saves', 'copy-source'].some((flag) =>
  new URLSearchParams(location.search).has(flag),
);
let available = true;
const runtime = huddleRuntimeFixture(() => document);
let executionSupported = !new URLSearchParams(location.search).has('old-execution');
let revision = 10;
const changedRevision = () => {
  document.digest = (++revision).toString(16).padStart(64, '0');
};
let opened = false;
if (new URLSearchParams(location.search).has('view-state') || capturedSaves) {
  fixture.addSession(saved);
  opened = true;
}
let failLayoutRead = false;
let removedAuthoringAccount: number | undefined;
let authoringFailure = false;
let releaseAuthoring: (() => void) | undefined;
let authoringWait: Promise<void> | undefined;
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
    (!capturedSaves ||
      !executionSupported ||
      new URLSearchParams(location.search).has('old-review') ||
      new URLSearchParams(location.search).has('old-templates') ||
      new URLSearchParams(location.search).has('old-spawn') ||
      new URLSearchParams(location.search).has('old-owned') ||
      new URLSearchParams(location.search).has('old-layout'))
  ) {
    const version = await transport.request(method, path, body).then((response) => response.json());
    return Response.json({
      ...version,
      protocol: {
        major: 28,
        minor: !executionSupported
          ? 1
          : new URLSearchParams(location.search).has('old-review')
            ? 9
            : new URLSearchParams(location.search).has('old-owned')
              ? 8
              : new URLSearchParams(location.search).has('old-spawn')
                ? 7
                : new URLSearchParams(location.search).has('old-layout')
                  ? 3
                  : new URLSearchParams(location.search).has('old-templates')
                    ? 2
                    : 10,
      },
    });
  }
  if (
    new URLSearchParams(location.search).has('spawn-templates') ||
    new URLSearchParams(location.search).has('agent-authoring')
  ) {
    const accounts = [
      { id: 11, label: 'Primary', agent_type: 'claude', logged_in: true },
      { id: 12, label: 'Coding', agent_type: 'codex', logged_in: true },
      { id: 13, label: 'Logged out', agent_type: 'claude', logged_in: false },
      { id: 14, label: 'Unsupported', agent_type: 'plain', logged_in: true },
      { id: 15, label: 'Other profile', agent_type: 'codex', logged_in: true },
    ]
      .filter((account) => account.id !== removedAuthoringAccount)
      .map((account) => ({
        ...account,
        profile_id: account.id === 15 ? 'another-profile' : profile.id,
        config_dir: '/preview/accounts',
        skip_permissions_default: false,
        created_at: '2026-01-01T00:00:00Z',
      }));
    if (path === '/api/accounts') return Response.json(accounts);
    if (path === '/api/sessions' && method === 'POST') {
      await authoringWait;
      const account = accounts.find((item) => item.id === body.account_id)!;
      const agent = sessionSchema.parse({
        ...sessions[0],
        id: '00000000-0000-4000-8000-000000000008',
        title: body.title,
        project_id: body.project_id,
        worktree_path: body.join_worktree,
        account_id: account.id,
        agent_type: account.agent_type,
        status: 'exited',
      });
      fixture.addSession(agent);
      if (authoringFailure) throw new TypeError('Synthetic lost creation reply');
      return Response.json(agent, { status: 201 });
    }
    if (path === `/api/puddlang/${profile.id}/context`)
      return Response.json({
        profile: { id: profile.id, name: profile.name },
        projects: [{ id: project.id, name: project.name, path: '/preview/puddle' }],
        accounts: accounts.map((account) => ({ ...account, agent: account.agent_type })),
        agents: [
          { id: 'claude', scripted_turns: true, modes: ['interactive', 'headless'] },
          { id: 'codex', scripted_turns: true, modes: ['interactive', 'headless'] },
          { id: 'plain', scripted_turns: false },
        ],
      });
  }
  if (new URLSearchParams(location.search).has('retained-history')) {
    if (path === `${prefix}/sessions/${saved.id}/revision/retained`)
      return retainedHistory.revision(body);
    const action = path.match(
      new RegExp(`^${prefix}/sessions/${saved.id}/history/(owners|retained)$`),
    );
    if (action) return retainedHistory.request(action[1]!, body);
  }
  const execution = path.match(new RegExp(`^${prefix}/sessions/([^/]+)/(readouts/observe|[^/]+)$`));
  if (execution)
    return runtime.request(
      execution[1]!,
      execution[2]!,
      body,
      url.searchParams.get('include_readout_observation') === 'true',
      url.searchParams.get('include_custom_triggers') === 'true',
    );
  if (path === `${prefix}/availability`)
    return Response.json(
      available
        ? { available: true, build: 'fixture', lifetime: 'service' }
        : { available: false, reason: 'Install a runtime with huddle support' },
    );
  if (path === `${prefix}/definitions` && method === 'GET')
    return Response.json(
      [document, ...(blank ? [blank] : []), ...(copied ? [copied] : [])].map((item) => ({
        id: item.definition.id,
        name: item.definition.name,
        digest: item.digest,
        diagnostics: [],
      })),
    );
  if (path === `${prefix}/definitions/${savedId}/source`) return source.request(method, body);
  if (path === `${prefix}/definitions/${savedId}/validate` && method === 'POST')
    return Response.json({
      valid: !body.fixtures?.length,
      digest: document.digest,
      diagnostics: body.fixtures?.length
        ? [
            {
              severity: 'error',
              code: 'fixture_value',
              node: 'run',
              path: `/fixtures/${body.fixtures[0]}/cases/0/inputs`,
              message: 'Sample: invalid fixture input',
            },
          ]
        : [],
      checks: { modules: true, fixtures: [] },
    });
  if (path === `${prefix}/definitions/${createdId}/source` && blank)
    return sourceFixture(blank, disk, components).request(method, body);
  if (path === `${prefix}/definitions/${copiedId}/source` && copied)
    return sourceFixture(copied, disk, components).request(method, body);
  if (path === `${prefix}/definitions/${savedId}`) return Response.json(document);
  if (path === `${prefix}/definitions/${createdId}`) return Response.json(blank);
  if (path === `${prefix}/definitions/${copiedId}`) return Response.json(copied);
  if (path === `${prefix}/definitions/${savedId}/duplicate` && method === 'POST') {
    if (!available || body.expected_digest !== document.digest)
      return Response.json(
        { error: { code: 'stale', message: 'Source changed' } },
        { status: 409 },
      );
    copied = huddleDocumentSchema.parse({
      ...document,
      digest: 'e'.repeat(64),
      definition: { ...document.definition, id: copiedId, name: body.name },
    });
    const session = sessionSchema.parse({
      ...saved,
      id: '00000000-0000-4000-8000-000000000008',
      huddle_id: copiedId,
      title: body.name,
    });
    disk.set(copiedId, { content: JSON.stringify(copied.definition, null, 2), mtime: 1 });
    fixture.addSession(session);
    return Response.json({ created: true, session, document: copied }, { status: 201 });
  }
  const install = path.match(new RegExp(`^${prefix}/definitions/([^/]+)/components$`));
  if (install && method === 'POST') {
    const template = huddleTemplateFiles(body.template, body.builtin);
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
    const starter = body.template
      ? huddleStarterFiles(body.template, createdId, body.name, body.worktree)
      : undefined;
    blank = huddleDocumentSchema.parse({
      ...document,
      definition:
        starter?.definition ??
        huddleDefinitionSchema.parse({
          format: 1,
          id: createdId,
          name: body.name,
          nodes: [],
          edges: [],
        }),
      layout: starter?.layout,
      components: starter
        ? Object.fromEntries(
            starter.definition.nodes.map((node) => [
              node.id,
              node.source.kind === 'local'
                ? JSON.parse(starter.files[node.source.manifest]!)
                : document.components[node.id],
            ]),
          )
        : {},
    });
    if (starter)
      for (const [name, content] of Object.entries(starter.files)) {
        if (name !== 'huddle.json')
          components.set(`.puddle/huddle/${createdId}/${name}`, { content, mtime: 1 });
      }
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
    sourceControls: source,
    retainedHistory,
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
    removeAuthoringAccount: (id: number) => {
      removedAuthoringAccount = id;
    },
    failAuthoring: () => {
      authoringFailure = true;
    },
    holdAuthoring: () => {
      authoringWait = new Promise<void>((resolve) => {
        releaseAuthoring = resolve;
      });
    },
    releaseAuthoring: () => {
      releaseAuthoring?.();
    },
  },
});
