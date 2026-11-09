import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  huddleDocumentSchema,
  huddleOpenedSchema,
  runtimeReleaseCapabilities,
} from '@puddle/shared';
import { openDatabase } from '../../../src/db/db.js';
import { HuddlePlacements } from '../../../src/db/stores/huddle/placements.js';
import { ProfileStore } from '../../../src/db/stores/profiles.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { RepoStore } from '../../../src/db/stores/repos.js';
import { SessionStore } from '../../../src/db/stores/sessions.js';
import { WorktreeManager } from '../../../src/worktrees/manager.js';
import { KeyedMutex } from '../../../src/git/mutex.js';
import { resolvePaths } from '../../../src/paths.js';
import * as capture from '../../../src/huddle/definitions/capture.js';
import { HuddleService } from '../../../src/huddle/control/service.js';
import { resolveHuddleRuntimeRelease } from '../../../src/runtime/huddle/control/release.js';
import { huddleAuthoringRoutes } from '../../../src/http/routes/execution/huddle/authoring.js';
import { ApiError } from '../../../src/http/errors.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import { createHuddleDefinition } from '../../../src/huddle/definitions/create.js';
import { HuddleClient } from '../../../../cli/src/huddle/client.js';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { callHuddleTool } from '../../../../cli/src/huddle/mcp.js';
import { parseHuddleCommand, runHuddleCommand } from '../../../../cli/src/huddle/commands.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-huddle-authoring-')));
  const worktree = join(home, 'project');
  mkdirSync(worktree);
  execFileSync('git', ['init', '-b', 'main', worktree], { stdio: 'ignore' });
  const db = openDatabase(join(home, 'db.sqlite'));
  cleanups.push(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const profiles = new ProfileStore(db);
  const projects = new ProjectStore(db);
  const repos = new RepoStore(db);
  const sessions = new SessionStore(db);
  const profile = profiles.create({ name: 'Huddles', branch_prefix: '' });
  const repo = repos.create({
    path: worktree,
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: false,
  });
  const project = projects.create({ profile_id: profile.id, repo_id: repo.id, name: 'Project' });
  const release = runtimeRelease(
    home,
    '1.2.3',
    `${RUNTIME_PROTOCOL_VERSION.major}.${RUNTIME_PROTOCOL_VERSION.minor}`,
  );
  mkdirSync(join(release.release, 'daemon/huddle'));
  for (const name of ['runner.js', 'sdk.js'])
    writeFileSync(join(release.release, 'daemon/huddle', name), '// never execute');
  writeFileSync(
    join(release.release, 'RUNTIME_CAPABILITIES.json'),
    JSON.stringify(runtimeReleaseCapabilities('1.2.3')),
  );
  release.select();
  const changed = vi.fn();
  const storage = { assertAdmission: vi.fn(async (_paths: string[]) => {}) };
  const checkHuddleAvailable = vi.fn(async () => ({
    selected: resolveHuddleRuntimeRelease(home),
    lifetime: 'service' as const,
  }));
  const worktrees = new WorktreeManager({
    paths: resolvePaths(home),
    mutex: new KeyedMutex(),
    repos,
    sessions,
  });
  const placements = new HuddlePlacements(db);
  const service = new HuddleService({
    home,
    profiles,
    projects,
    repos,
    placements,
    worktrees,
    changed,
    storage,
    launcher: { checkHuddleAvailable },
  });
  const input = { project_id: project.id, worktree, name: 'Review' };
  let valid = true;
  const authority = () => valid;
  const create = () => service.create(profile.id, input, authority);
  const location = { project_id: project.id, worktree };
  return {
    home,
    worktree,
    db,
    profiles,
    profile,
    project,
    projects,
    placements,
    service,
    release,
    changed,
    storage,
    checkHuddleAvailable,
    input,
    location,
    authority,
    create,
    revoke: () => {
      valid = false;
    },
    unsupported: () => {
      rmSync(join(release.release, 'RUNTIME_CAPABILITIES.json'));
    },
  };
}

describe('inactive huddle authoring', () => {
  it('copies saved source through CLI/HTTP with fresh stopped identity, rejects stale/unsafe source and observes a lost reply without retry', async () => {
    const f = fixture();
    const original = await f.create();
    const target = { ...f.location, huddle_id: original.session.huddle_id! };
    const source = join(f.worktree, '.puddle/huddle', target.huddle_id);
    await f.service.installTemplate(
      f.profile.id,
      { ...target, template: 'format-text', component: 'format' },
      f.authority,
    );
    const graph = {
      ...original.document.definition,
      nodes: [
        { id: 'run', source: { kind: 'builtin', component: 'puddle.trigger.manual', version: 1 } },
        { id: 'format', source: { kind: 'local', manifest: 'nodes/format/node.json' } },
      ],
      edges: [
        {
          id: 'input',
          from: { node: 'run', port: 'event' },
          to: { node: 'format', port: 'value' },
        },
      ],
    };
    writeFileSync(join(source, 'huddle.json'), JSON.stringify(graph));
    writeFileSync(join(source, 'layout.json'), '{"format":1,"nodes":{"format":{"x":20,"y":30}}}\n');
    writeFileSync(join(source, 'README.md'), 'Keep the purpose and fixtures.\n');
    mkdirSync(join(source, 'fixtures/empty'), { recursive: true });
    writeFileSync(join(source, 'fixtures/input.json'), '{"message":"saved"}\n');
    const inspected = await f.service.inspect(f.profile.id, target, f.authority);
    const app = new Hono()
      .use('*', async (c, next) => {
        c.set('authorityValid', f.authority);
        await next();
      })
      .route('/api/huddle', huddleAuthoringRoutes(f.service));
    app.onError((error, c) =>
      c.json(
        { error: error instanceof ApiError ? error.code : error.message },
        error instanceof ApiError ? (error.status as 400) : 500,
      ),
    );
    let loseReply = false;
    const request = vi.fn(async (path: string, body?: unknown) => {
      const response = await app.request(`/api/huddle/${f.profile.id}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      if (loseReply && body !== undefined) throw new Error('Lost copy reply');
      return response.json();
    });
    const client = new HuddleClient(request, PROTOCOL_VERSION);
    const print = vi.fn();
    const command = parseHuddleCommand(['duplicate', target.huddle_id], {
      project: f.project.id,
      worktree: f.worktree,
      name: 'Independent copy',
      request: JSON.stringify({ expected_digest: inspected.digest }),
    });
    expect(await runHuddleCommand(client, command, print)).toBe(0);
    const copied = huddleOpenedSchema.parse(print.mock.calls[0]![0]);
    expect(copied.session).toMatchObject({
      kind: 'huddle',
      status: 'exited',
      worktree_path: f.worktree,
    });
    expect(copied.session.id).not.toBe(original.session.id);
    expect(copied.session.huddle_id).toMatch(/^[a-f0-9]{32}$/);
    expect(copied.session.huddle_id).not.toBe(target.huddle_id);
    expect(copied.document.definition).toEqual({
      ...inspected.definition,
      id: copied.session.huddle_id,
      name: 'Independent copy',
    });
    const destination = join(f.worktree, '.puddle/huddle', copied.session.huddle_id);
    for (const file of [
      'layout.json',
      'README.md',
      'fixtures/input.json',
      'nodes/format/node.json',
      'nodes/format/run.ts',
      'nodes/format/prompt.ts',
    ])
      expect(readFileSync(join(destination, file), 'utf8')).toBe(
        readFileSync(join(source, file), 'utf8'),
      );
    expect(readdirSync(join(destination, 'fixtures/empty'))).toEqual([]);
    expect(readFileSync(join(source, 'huddle.json'), 'utf8')).toBe(JSON.stringify(graph));
    const input = { ...target, name: 'Another copy', expected_digest: inspected.digest };
    await expect(
      new HuddleClient(request, { major: 28, minor: 25 }).duplicate(input),
    ).rejects.toThrow('28.26');
    const count = readdirSync(join(f.worktree, '.puddle/huddle')).length;
    await expect(client.duplicate({ ...input, expected_digest: '0'.repeat(64) })).rejects.toThrow(
      'huddle_source_changed',
    );
    symlinkSync(join(source, 'README.md'), join(source, 'shortcut'));
    await expect(client.duplicate(input)).rejects.toThrow('ordinary files');
    rmSync(join(source, 'shortcut'));
    expect(readdirSync(join(f.worktree, '.puddle/huddle'))).toHaveLength(count);
    loseReply = true;
    const before = request.mock.calls.length;
    await expect(callHuddleTool(client, 'huddle_duplicate', input)).rejects.toThrow(
      /Lost copy reply.*\n.*Do not retry automatically/,
    );
    expect(request.mock.calls.length).toBe(before + 1);
    const observed = await client.list(f.location);
    expect(observed).toHaveLength(count + 1);
    expect(observed.some((entry) => 'name' in entry && entry.name === input.name)).toBe(true);
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
    expect(f.db.prepare('SELECT status FROM sessions').all()).toEqual([
      { status: 'exited' },
      { status: 'exited' },
      { status: 'exited' },
    ]);
  });
  it('round-trips captured source through the real CLI/HTTP path, refuses competing revisions and retains text after a lost reply', async () => {
    const f = fixture();
    const definition = createHuddleDefinition(f.worktree, 'Source');
    f.unsupported();
    const app = new Hono()
      .use('*', async (c, next) => {
        c.set('authorityValid', f.authority);
        await next();
      })
      .route('/api/huddle', huddleAuthoringRoutes(f.service));
    app.onError((error, c) =>
      c.json(
        { error: error instanceof ApiError ? error.code : 'internal' },
        error instanceof ApiError ? (error.status as 400) : 500,
      ),
    );
    let loseReply = false;
    const request = vi.fn(async (path: string, body?: unknown, method?: 'PUT') => {
      const response = await app.request(`/api/huddle/${f.profile.id}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      if (loseReply && method === 'PUT') throw new Error('Lost response after publication');
      return response.json();
    });
    const client = new HuddleClient(request, PROTOCOL_VERSION);
    const target = { ...f.location, huddle_id: definition.id };
    const baseline = await client.source.read(target);
    const content = `${'\t'.repeat(200_000)}${JSON.stringify({ format: 1, id: definition.id, name: 'Exact 🦆', nodes: [], edges: [] })}\r\n`;
    const input = {
      ...target,
      expected_digest: baseline.document.digest,
      edit: { file: 'huddle.json' as const, content },
    };
    const saved = await client.source.save(input);
    expect(saved.files['huddle.json']).toBe(content);
    expect(saved.document.definition.name).toBe('Exact 🦆');
    await expect(client.source.save(input)).rejects.toThrow('huddle_source_changed');
    loseReply = true;
    const next = {
      ...input,
      expected_digest: saved.document.digest,
      edit: { file: 'layout.json' as const, content: '{"nodes":{}, "format":1}' },
    };
    const calls = request.mock.calls.length;
    await expect(client.source.save(next)).rejects.toThrow(
      /Lost response.*\n.*Do not retry automatically/,
    );
    expect(request.mock.calls.length).toBe(calls + 1);
    const observed = await client.source.read(target);
    expect(observed.files['layout.json']).toBe(next.edit.content);
    expect(observed.document.digest).not.toBe(next.expected_digest);
    expect(f.checkHuddleAvailable).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
  });

  it('serves CLI source validation without a placement, capable runtime or module evaluation', async () => {
    const f = fixture();
    const definition = createHuddleDefinition(f.worktree, 'Agent-authored graph');
    const root = join(f.worktree, '.puddle/huddle', definition.id);
    const marker = join(root, 'executed');
    mkdirSync(join(root, 'nodes/example'), { recursive: true });
    writeFileSync(
      join(root, 'nodes/example/node.json'),
      JSON.stringify({
        format: 1,
        id: 'example.transform',
        version: 1,
        category: 'script',
        title: 'Transform',
        inputs: { value: { schema: {} } },
        outputs: { completed: { schema: {} } },
        entry: './run.ts',
      }),
    );
    writeFileSync(
      join(root, 'nodes/example/run.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default {};`,
    );
    const graph = {
      ...definition,
      nodes: [
        { id: 'run', source: { kind: 'builtin', component: 'puddle.trigger.manual', version: 1 } },
        { id: 'transform', source: { kind: 'local', manifest: 'nodes/example/node.json' } },
      ],
      edges: [
        {
          id: 'input',
          from: { node: 'run', port: 'event' },
          to: { node: 'transform', port: 'value' },
        },
      ],
    };
    writeFileSync(join(root, 'huddle.json'), JSON.stringify(graph));
    f.unsupported();
    const app = new Hono()
      .use('*', async (c, next) => {
        c.set('authorityValid', f.authority);
        await next();
      })
      .route('/api/huddle', huddleAuthoringRoutes(f.service));
    app.onError((error, c) =>
      c.json(
        { error: error instanceof ApiError ? error.code : 'internal' },
        error instanceof ApiError ? (error.status as 400) : 500,
      ),
    );
    const methods: string[] = [];
    const client = new HuddleClient(async (path) => {
      methods.push(path);
      const response = await app.request(`/api/huddle/${f.profile.id}${path}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }, PROTOCOL_VERSION);
    const target = { ...f.location, huddle_id: definition.id };
    expect(await client.list(f.location)).toEqual([expect.objectContaining({ id: definition.id })]);
    expect((await client.validate(target)).valid).toBe(true);
    const digest = (await client.inspect(target)).digest;
    const captured = await client.source.read(target);
    expect(captured.document.digest).toBe(digest);
    expect(Object.keys(captured.document.components).sort()).toEqual(['run', 'transform']);
    expect(captured.files['nodes/example/run.ts']).toBe(
      readFileSync(join(root, 'nodes/example/run.ts'), 'utf8'),
    );
    graph.edges[0]!.to.port = 'absent';
    writeFileSync(join(root, 'huddle.json'), JSON.stringify(graph));
    const result = await client.validate(target);
    expect(result.valid).toBe(false);
    expect(result.digest).not.toBe(digest);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', edge: 'input' })]),
    );
    expect(existsSync(marker)).toBe(false);
    expect(f.checkHuddleAvailable).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
    f.revoke();
    await expect(client.inspect(target)).rejects.toThrow('HTTP 401');
    expect(methods).toHaveLength(6);
  });
  it.each(['prompt-agent', 'spawn-agent', 'prompt-spawned-agent', 'review-spawned-agent'] as const)(
    'materialises editable %s templates without changing the graph, overwriting edits or starting an owner',
    async (template) => {
      const f = fixture();
      const opened = await f.create();
      const input = {
        ...f.location,
        huddle_id: opened.session.huddle_id!,
        template,
        component: 'coder',
      };
      const installed = await f.service.installTemplate(f.profile.id, input, f.authority);
      expect(installed.manifest).toBe('nodes/coder/node.json');
      const root = join(f.worktree, '.puddle/huddle', input.huddle_id);
      expect(readFileSync(join(root, 'nodes/coder/run.ts'), 'utf8')).toContain('HuddleNode');
      expect(await f.service.installTemplate(f.profile.id, input, f.authority)).toEqual(installed);
      expect(
        (
          await f.service.inspect(
            f.profile.id,
            { ...f.location, huddle_id: input.huddle_id },
            f.authority,
          )
        ).digest,
      ).toBe(opened.document.digest);
      writeFileSync(join(root, 'nodes/coder/run.ts'), '// user edit');
      await expect(
        f.service.installTemplate(f.profile.id, input, f.authority),
      ).rejects.toMatchObject({ code: 'huddle_component_exists' });
      expect(readFileSync(join(root, 'nodes/coder/run.ts'), 'utf8')).toBe('// user edit');
      expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
    },
  );

  it('refuses template path escapes and revocation before publication', async () => {
    const f = fixture();
    const opened = await f.create();
    const root = join(f.worktree, '.puddle/huddle', opened.session.huddle_id!);
    symlinkSync(f.home, join(root, 'nodes'));
    const input = {
      ...f.location,
      huddle_id: opened.session.huddle_id!,
      template: 'review-agent' as const,
      component: 'reviewer',
    };
    await expect(f.service.installTemplate(f.profile.id, input, f.authority)).rejects.toThrow();
    expect(existsSync(join(f.home, 'reviewer'))).toBe(false);
    rmSync(join(root, 'nodes'));
    f.storage.assertAdmission.mockImplementationOnce(async () => {
      f.revoke();
    });
    await expect(f.service.installTemplate(f.profile.id, input, f.authority)).rejects.toThrow();
    expect(existsSync(join(root, 'nodes'))).toBe(false);
  });

  it('creates multiple random definitions and one stopped placement each without launching anything', async () => {
    const f = fixture();
    const first = huddleOpenedSchema.parse(await f.create());
    const second = await f.create();
    expect(first.session).toMatchObject({
      kind: 'huddle',
      status: 'exited',
      account_id: null,
      branch_owner: false,
      worktree_path: f.worktree,
    });
    expect(first.document.definition).toMatchObject({ name: 'Review', nodes: [], edges: [] });
    expect(first.session.huddle_id).toMatch(/^[a-f0-9]{32}$/);
    expect(second.session.huddle_id).not.toBe(first.session.huddle_id);
    const manifest = join(f.worktree, '.puddle/huddle', first.session.huddle_id!, 'huddle.json');
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(first.document.definition);
    const alias = join(f.home, 'alias');
    symlinkSync(f.worktree, alias);
    const opened = await Promise.all(
      Array.from({ length: 3 }, () =>
        f.service.open(
          f.profile.id,
          { ...f.location, worktree: alias, huddle_id: first.session.huddle_id! },
          f.authority,
        ),
      ),
    );
    expect(
      opened.every((result) => result.session.id === first.session.id && !result.created),
    ).toBe(true);
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM terminal_placements').all()).toEqual([]);
    expect(await f.service.discover(f.profile.id, f.location, f.authority)).toHaveLength(2);
    expect(first.document).not.toHaveProperty('files');
  });

  it('requires capable runtime metadata before writes but permits existing placement inspection after default changes', async () => {
    const f = fixture();
    f.unsupported();
    expect(await f.service.availability(f.profile.id, f.authority)).toMatchObject({
      available: false,
    });
    await expect(f.create()).rejects.toMatchObject({ code: 'huddle_runtime_unavailable' });
    expect(existsSync(join(f.worktree, '.puddle'))).toBe(false);
    writeFileSync(
      join(f.release.release, 'RUNTIME_CAPABILITIES.json'),
      JSON.stringify(runtimeReleaseCapabilities('1.2.3')),
    );
    const first = await f.create();
    f.unsupported();
    const input = { ...f.location, huddle_id: first.session.huddle_id! };
    expect((await f.service.open(f.profile.id, input, f.authority)).session.id).toBe(
      first.session.id,
    );
    expect((await f.service.inspect(f.profile.id, input, f.authority)).digest).toBe(
      first.document.digest,
    );
    const other = f.projects.create({
      profile_id: f.profile.id,
      repo_id: f.project.repo_id,
      name: 'Other',
    });
    await expect(
      f.service.open(f.profile.id, { ...input, project_id: other.id }, f.authority),
    ).rejects.toMatchObject({ code: 'huddle_runtime_unavailable' });
  });

  it.each(['revoke', 'archive', 'selection', 'storage'] as const)(
    'rejects %s changes after async admission before creating source',
    async (mode) => {
      const f = fixture();
      f.storage.assertAdmission.mockImplementationOnce(async () => {
        if (mode === 'revoke') f.revoke();
        if (mode === 'archive') f.projects.setArchived(f.project.id, true);
        if (mode === 'selection') runtimeRelease(f.home, '2.0.0', '1.1').select();
        if (mode === 'storage') throw new Error('Storage full');
      });
      await expect(f.create()).rejects.toThrow();
      expect(existsSync(join(f.worktree, '.puddle'))).toBe(false);
      expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    },
  );

  it('rejects cross-profile and unregistered/subdirectory roots and symlinked collections', async () => {
    const f = fixture();
    const other = f.profiles.create({ name: 'Other', branch_prefix: '' });
    await expect(f.service.create(other.id, f.input, f.authority)).rejects.toMatchObject({
      code: 'profile_scope',
    });
    const child = join(f.worktree, 'nested');
    mkdirSync(child);
    for (const root of [child, f.home, '.', join(f.home, 'missing')]) {
      await expect(
        f.service.create(f.profile.id, { ...f.input, worktree: root }, f.authority),
      ).rejects.toThrow();
    }
    const outside = join(f.home, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(f.worktree, '.puddle'));
    await expect(f.create()).rejects.toThrow(/ordinary directories/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('retains published source after lost placement admission so discovery/open can recover it', async () => {
    const f = fixture();
    const open = vi.spyOn(f.placements, 'open').mockImplementationOnce(() => {
      throw new Error('placement write failed');
    });
    await expect(f.create()).rejects.toThrow('placement write failed');
    expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    open.mockRestore();
    const discovered = await f.service.discover(f.profile.id, f.location, f.authority);
    expect(discovered).toHaveLength(1);
    const recovered = await f.service.open(
      f.profile.id,
      { ...f.location, huddle_id: discovered[0]!.id },
      f.authority,
    );
    expect(recovered.created).toBe(true);
    expect(recovered.session.status).toBe('exited');
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
  });

  it('rechecks authority after source capture before creating a placement', async () => {
    const f = fixture();
    const original = capture.captureHuddleDefinition;
    vi.spyOn(capture, 'captureHuddleDefinition').mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args);
      f.revoke();
      return snapshot;
    });
    await expect(f.create()).rejects.toMatchObject({ code: 'upstream_expired' });
    expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    expect(readdirSync(join(f.worktree, '.puddle/huddle'))).toHaveLength(1);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('saves inactive drafts, serialises competing writers and rejects stale source without runtime support', async () => {
    const f = fixture();
    const opened = await f.create();
    f.unsupported();
    f.checkHuddleAvailable.mockClear();
    const input = {
      ...f.location,
      huddle_id: opened.session.huddle_id!,
      expected_digest: opened.document.digest,
      edit: {
        file: 'huddle.json' as const,
        value: { ...opened.document.definition, name: 'Edited' },
      },
    };
    const outcomes = await Promise.allSettled([
      f.service.save(f.profile.id, input, f.authority),
      f.service.save(
        f.profile.id,
        { ...input, edit: { ...input.edit, value: { ...input.edit.value, name: 'Other window' } } },
        f.authority,
      ),
    ]);
    expect(outcomes.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(outcomes.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'huddle_source_changed' },
    });
    const document = await f.service.inspect(
      f.profile.id,
      { ...f.location, huddle_id: input.huddle_id },
      f.authority,
    );
    expect(document.definition.name).toBe(
      outcomes[0]!.status === 'fulfilled' ? 'Edited' : 'Other window',
    );
    expect(document.digest).not.toBe(input.expected_digest);
    expect(f.checkHuddleAvailable).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM sessions').all()).toHaveLength(1);
  });

  it.each(['source', 'layout', 'revoke', 'archive', 'storage'] as const)(
    'rechecks %s after asynchronous save admission',
    async (mode) => {
      const f = fixture();
      const opened = await f.create();
      const root = join(f.worktree, '.puddle/huddle', opened.session.huddle_id!);
      const original = readFileSync(join(root, 'huddle.json'), 'utf8');
      f.storage.assertAdmission.mockImplementationOnce(async () => {
        if (mode === 'source') writeFileSync(join(root, 'huddle.json'), `${original}\n`);
        if (mode === 'layout') writeFileSync(join(root, 'layout.json'), '{"format":1,"nodes":{}}');
        if (mode === 'revoke') f.revoke();
        if (mode === 'archive') f.projects.setArchived(f.project.id, true);
        if (mode === 'storage') throw new Error('Storage full');
      });
      await expect(
        f.service.save(
          f.profile.id,
          {
            ...f.location,
            huddle_id: opened.session.huddle_id!,
            expected_digest: opened.document.digest,
            edit: {
              file: 'huddle.json',
              value: { ...opened.document.definition, name: 'Must not save' },
            },
          },
          f.authority,
        ),
      ).rejects.toThrow();
      expect(readFileSync(join(root, 'huddle.json'), 'utf8')).toBe(
        mode === 'source' ? `${original}\n` : original,
      );
      expect(readdirSync(root).some((name) => name.startsWith('.puddle-save-'))).toBe(false);
    },
  );

  it('retains a published draft when response observation fails and requires inspection before another edit', async () => {
    const f = fixture();
    const opened = await f.create();
    const input = {
      ...f.location,
      huddle_id: opened.session.huddle_id!,
      expected_digest: opened.document.digest,
      edit: {
        file: 'huddle.json' as const,
        value: {
          ...opened.document.definition,
          name: 'Saved before reply failed',
          edges: [
            {
              id: 'unfinished',
              from: { node: 'missing', port: 'out' },
              to: { node: 'also-missing', port: 'in' },
            },
          ],
        },
      },
    };
    const original = capture.captureHuddleDefinition;
    const spy = vi
      .spyOn(capture, 'captureHuddleDefinition')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('Observation failed'));
    await expect(f.service.save(f.profile.id, input, f.authority)).rejects.toMatchObject({
      code: 'huddle_definition_invalid',
    });
    spy.mockRestore();
    const document = await f.service.inspect(
      f.profile.id,
      { ...f.location, huddle_id: input.huddle_id },
      f.authority,
    );
    expect(document.definition).toEqual(input.edit.value);
    expect(document.diagnostics.some((item) => item.severity === 'error')).toBe(true);
    await expect(f.service.save(f.profile.id, input, f.authority)).rejects.toMatchObject({
      code: 'huddle_source_changed',
    });
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
  });

  it('exposes strict local authoring routes and refuses remote or revoked authority', async () => {
    const f = fixture();
    let remote = false;
    const authority: MiddlewareHandler = async (c, next) => {
      c.set('authorityValid', f.authority);
      c.set('remoteProfile', remote ? f.profile.id : undefined);
      await next();
    };
    const app = new Hono()
      .use('*', authority)
      .route('/api/huddle', huddleAuthoringRoutes(f.service));
    app.onError((error, c) =>
      c.json(
        { code: error instanceof ApiError ? error.code : 'internal' },
        error instanceof ApiError ? (error.status as 400) : 500,
      ),
    );
    const path = `/api/huddle/${f.profile.id}`;
    const post = (body: unknown) =>
      app.request(`${path}/definitions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ ...f.input, host_id: 'untrusted' })).status).toBe(400);
    const response = await post(f.input);
    expect(response.status).toBe(201);
    const opened = huddleOpenedSchema.parse(await response.json());
    const install = (extra: object = {}) =>
      app.request(`${path}/definitions/${opened.session.huddle_id}/components`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...f.location,
          template: 'prompt-agent',
          component: 'coder',
          ...extra,
        }),
      });
    expect((await install({ component: '../escape' })).status).toBe(400);
    expect((await install({ host_id: 'untrusted' })).status).toBe(400);
    expect((await install()).status).toBe(200);
    const query = new URLSearchParams(f.location);
    const sourcePath = `${path}/definitions/${opened.session.huddle_id}/source`;
    const readSource = () => app.request(`${sourcePath}?${query}`);
    const saveSource = () =>
      app.request(sourcePath, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...f.location,
          expected_digest: opened.document.digest,
          edit: { file: 'layout.json', content: '{"format":1,"nodes":{}}' },
        }),
      });
    expect((await readSource()).status).toBe(200);
    expect((await app.request(`${path}/definitions?${query}`)).status).toBe(200);
    expect(
      (await app.request(`${path}/definitions/${opened.session.huddle_id}?${query}`)).status,
    ).toBe(200);
    const save = (edit: unknown, expected_digest = opened.document.digest) =>
      app.request(`${path}/definitions/${opened.session.huddle_id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...f.location, expected_digest, edit }),
      });
    const edit = { file: 'layout.json', value: { format: 1, nodes: {} } };
    expect((await save({ ...edit, unknown: true })).status).toBe(400);
    const saved = await save(edit);
    expect(saved.status).toBe(200);
    expect(huddleDocumentSchema.parse(await saved.json()).layout).toEqual(edit.value);
    expect((await save(edit)).status).toBe(409);
    remote = true;
    expect((await readSource()).status).toBe(403);
    expect((await saveSource()).status).toBe(403);
    expect((await install()).status).toBe(403);
    expect((await save(edit)).status).toBe(403);
    expect((await post(f.input)).status).toBe(403);
    expect((await app.request(`${path}/availability`)).status).toBe(403);
    remote = false;
    f.revoke();
    expect((await readSource()).status).toBe(401);
    expect((await saveSource()).status).toBe(401);
    expect((await install()).status).toBe(401);
    expect((await save(edit)).status).toBe(401);
    expect((await post(f.input)).status).toBe(401);
    expect(f.db.prepare('SELECT * FROM sessions').all()).toHaveLength(1);
  });
});
