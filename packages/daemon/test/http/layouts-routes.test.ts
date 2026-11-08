import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  savedLayoutSchema,
  windowArrangementSchema,
  type CreateLayoutRequest,
  type LayoutNode,
  type SavedLayout,
} from '@puddle/shared';
import { ApiError } from '../../src/http/errors.js';
import { layoutRoutes } from '../../src/http/routes/layouts.js';
import { fixture, type Fixture } from '../helpers/daemon-fixtures.js';

let fx: Fixture;
let app: Hono;
let profile: string;
let project: string;
let otherProject: string;

const SESSION = '3b241101-e2bb-4255-8caf-4136c566a962';
const tree = (session: string): LayoutNode => ({
  kind: 'leaf',
  id: 'leaf-1',
  tabs: [{ type: 'terminal', session }],
  activeKey: `term:${session}`,
  previewKey: null,
});

beforeAll(() => {
  fx = fixture();
  profile = fx.ids.profile;
  project = fx.ids.project;
  otherProject = fx.stores.projects.create({
    profile_id: profile,
    repo_id: fx.ids.repo,
    name: 'other',
  }).id;

  app = new Hono();
  app.onError((err, c) =>
    err instanceof ApiError
      ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      : c.json({ error: { code: 'internal', message: String(err) } }, 500),
  );
  app.route('/api/layouts', layoutRoutes(fx.stores));
});

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

const post = (body: CreateLayoutRequest) =>
  app.request('/api/layouts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const list = (proj?: string) =>
  app.request(`/api/layouts?profile=${profile}${proj ? `&project=${proj}` : ''}`);
const patch = (id: number, body: unknown) =>
  app.request(`/api/layouts/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('layouts CRUD + scope', () => {
  const arrangement = () =>
    windowArrangementSchema.parse({
      version: 1,
      windows: [
        {
          key: 'host',
          kind: 'host',
          project_id: project,
          layout_mode: 'profile',
          layout_tree: null,
          active_session: null,
          project_layouts: {},
        },
        {
          key: 'pane-one',
          kind: 'pane',
          project_id: project,
          layout_mode: 'profile',
          layout_tree: tree(SESSION),
          active_session: SESSION,
          project_layouts: {},
        },
      ],
    });

  it('retains window arrangements through list, rename and duplicate, with a browser fallback', async () => {
    const saved = savedLayoutSchema.parse(
      await (
        await post({
          profile_id: profile,
          scope: 'profile',
          name: 'native arrangement',
          layout_tree: tree(SESSION),
          active_session: SESSION,
          window_arrangement: arrangement(),
        })
      ).json(),
    );
    expect(saved.window_arrangement).toEqual(arrangement());
    expect(saved.layout_tree).toEqual(tree(SESSION));
    const renamed = savedLayoutSchema.parse(
      await (await patch(saved.id, { name: 'native renamed' })).json(),
    );
    expect(renamed.window_arrangement).toEqual(arrangement());
    const listed = (await (await list()).json()) as SavedLayout[];
    expect(listed.find((row) => row.id === saved.id)?.window_arrangement).toEqual(arrangement());
    const copy = savedLayoutSchema.parse(
      await (
        await post({
          profile_id: profile,
          scope: 'profile',
          name: 'native copy',
          layout_tree: renamed.layout_tree,
          active_session: renamed.active_session,
          window_arrangement: renamed.window_arrangement,
        })
      ).json(),
    );
    expect(copy.id).not.toBe(saved.id);
    expect(copy.window_arrangement).toEqual(saved.window_arrangement);
  });

  it('replaces the arrangement on an older client tree save, while explicit null can clear it', async () => {
    const saved = savedLayoutSchema.parse(
      await (
        await post({
          profile_id: profile,
          scope: 'profile',
          name: 'old client save',
          layout_tree: tree(SESSION),
          window_arrangement: arrangement(),
        })
      ).json(),
    );
    const overwritten = savedLayoutSchema.parse(
      await (await patch(saved.id, { layout_tree: null })).json(),
    );
    expect(overwritten.window_arrangement).toBeUndefined();
    expect(overwritten.layout_tree).toBeNull();
    expect((await patch(saved.id, { window_arrangement: arrangement() })).status).toBe(400);
    const replaced = savedLayoutSchema.parse(
      await (
        await patch(saved.id, {
          layout_tree: tree(SESSION),
          window_arrangement: arrangement(),
        })
      ).json(),
    );
    expect(replaced.window_arrangement).toEqual(arrangement());
    const cleared = savedLayoutSchema.parse(
      await (await patch(saved.id, { window_arrangement: null })).json(),
    );
    expect(cleared.window_arrangement).toBeUndefined();
    expect(cleared.layout_tree).toEqual(tree(SESSION));
  });

  it('accepts anchored panes but rejects other project ownership in a project save', async () => {
    const own = arrangement();
    own.windows[0] = {
      ...own.windows[0]!,
      layout_mode: 'project',
      project_layouts: { [project]: { layout_tree: null, active_session: null } },
    };
    const body: CreateLayoutRequest = {
      profile_id: profile,
      scope: 'project',
      project_id: project,
      name: 'project windows',
      layout_tree: tree(SESSION),
      window_arrangement: own,
    };
    const result = await post(body);
    expect(result.status).toBe(201);
    const saved = savedLayoutSchema.parse(await result.json());
    const foreign = structuredClone(own);
    foreign.windows[1]!.project_id = otherProject;
    expect((await post({ ...body, window_arrangement: foreign })).status).toBe(400);
    expect(
      (await patch(saved.id, { layout_tree: tree(SESSION), window_arrangement: foreign })).status,
    ).toBe(400);
    const otherSlice = structuredClone(own);
    otherSlice.windows[0]!.project_layouts[otherProject] = {
      layout_tree: tree(SESSION),
      active_session: SESSION,
    };
    expect((await post({ ...body, window_arrangement: otherSlice })).status).toBe(400);
    expect(fx.stores.layouts.get(saved.id).window_arrangement).toEqual(own);
  });

  it('rejects duplicate ownership, unknown versions and transient data without saving a partial row', async () => {
    const base = {
      profile_id: profile,
      scope: 'profile' as const,
      name: 'invalid windows',
      layout_tree: null,
    };
    const originalCount = fx.stores.layouts.list(profile).length;
    const duplicated = arrangement();
    duplicated.windows.push(duplicated.windows[1]!);
    expect((await post({ ...base, window_arrangement: duplicated })).status).toBe(400);
    const send = (window_arrangement: unknown) =>
      app.request('/api/layouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, window_arrangement }),
      });
    expect((await send({ ...arrangement(), version: 2 })).status).toBe(400);
    expect((await send({ ...arrangement(), buffers: [{ content: 'secret draft' }] })).status).toBe(
      400,
    );
    expect(
      (
        await send({
          version: 1,
          windows: arrangement().windows.map((window) => ({ ...window, bounds: { x: 20 } })),
        })
      ).status,
    ).toBe(400);
    expect(fx.stores.layouts.list(profile)).toHaveLength(originalCount);
  });

  it('creates project- and profile-scoped layouts and round-trips the tree', async () => {
    const p = await post({
      profile_id: profile,
      scope: 'project',
      project_id: project,
      name: 'terminal wall',
      layout_tree: tree(SESSION),
      active_session: SESSION,
    });
    expect(p.status).toBe(201);
    expect(savedLayoutSchema.parse(await p.json())).toMatchObject({
      scope: 'project',
      project_id: project,
      name: 'terminal wall',
      layout_tree: tree(SESSION),
      active_session: SESSION,
    });

    const g = await post({
      profile_id: profile,
      scope: 'profile',
      name: 'clean slate',
      layout_tree: null,
    });
    expect(g.status).toBe(201);
    expect(savedLayoutSchema.parse(await g.json())).toMatchObject({
      scope: 'profile',
      project_id: null,
      layout_tree: null,
      active_session: null,
    });
  });

  it('rejects a project-scoped layout without a project_id', async () => {
    const res = await post({
      profile_id: profile,
      scope: 'project',
      name: 'orphan',
      layout_tree: null,
    });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_scope');
  });

  it('scopes the list per project, and lists everything without one', async () => {
    const here = (await (await list(project)).json()) as SavedLayout[];
    expect(here.map((l) => l.name)).toContain('terminal wall');
    expect(here.map((l) => l.name)).toContain('clean slate');

    const there = (await (await list(otherProject)).json()) as SavedLayout[];
    expect(there.map((l) => l.name)).not.toContain('terminal wall'); // another project's
    expect(there.map((l) => l.name)).toContain('clean slate'); // profile-wide, still shown

    // No project (the dashboard): every layout of the profile, so none is
    // orphaned out of reach of rename/delete.
    const all = (await (await list()).json()) as SavedLayout[];
    expect(all.map((l) => l.name)).toContain('terminal wall');
    expect(all.map((l) => l.name)).toContain('clean slate');
  });

  it('renames and saves over via PATCH, and deletes', async () => {
    const created = savedLayoutSchema.parse(
      await (
        await post({ profile_id: profile, scope: 'profile', name: 'temp', layout_tree: null })
      ).json(),
    );
    const renamed = savedLayoutSchema.parse(
      await (await patch(created.id, { name: 'kept' })).json(),
    );
    expect(renamed.name).toBe('kept');
    expect(renamed.layout_tree).toBeNull();

    const savedOver = savedLayoutSchema.parse(
      await (
        await patch(created.id, { layout_tree: tree(SESSION), active_session: SESSION })
      ).json(),
    );
    expect(savedOver.name).toBe('kept');
    expect(savedOver.layout_tree).toEqual(tree(SESSION));
    expect(savedOver.active_session).toBe(SESSION);

    const del = await app.request(`/api/layouts/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect((await patch(created.id, { name: 'x' })).status).toBe(404);
  });

  it('404s an unknown profile on create, and empty list without a profile', async () => {
    const res = await post({
      profile_id: 'ffffffffff',
      scope: 'profile',
      name: 'x',
      layout_tree: null,
    });
    expect(res.status).toBe(404);
    expect(await (await app.request('/api/layouts')).json()).toEqual([]);
  });
});
