import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROFILE_ICON_COLOURS, projectSchema, projectCatalogueSchema } from '@puddle/shared';
import { ApiError } from '../../src/http/errors.js';
import { projectRoutes } from '../../src/http/routes/projects.js';
import { ConversationCatalogue } from '../../src/sessions/conversation-catalogue.js';
import { fixture, type Fixture } from '../helpers/daemon-fixtures.js';

let fx: Fixture;
let app: Hono;
let catalogue: ConversationCatalogue;

beforeAll(() => {
  fx = fixture();
  catalogue = new ConversationCatalogue({
    ...fx.stores,
    adapters: fx.adapters,
    worktrees: fx.worktrees,
  });
  app = new Hono();
  app.onError((err, c) =>
    err instanceof ApiError
      ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      : c.json({ error: { code: 'internal', message: String(err) } }, 500),
  );
  app.route('/api/projects', projectRoutes({ ...fx.stores, ...fx, catalogue }));
});

afterAll(async () => {
  await catalogue.dispose();
});

function request(method: string, path: string, body: unknown) {
  return app.request(`/api/projects${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('project colours', () => {
  it('stores every profile palette colour when creating a project', async () => {
    for (const colour of [...PROFILE_ICON_COLOURS, '#12a6bc', '#ABCDEF']) {
      const response = await request('POST', '', {
        profile_id: fx.ids.profile,
        repo_id: fx.ids.repo,
        name: `project-${colour}`,
        colour,
      });
      expect(response.status).toBe(201);
      const project = projectSchema.parse(await response.json());
      expect(project.colour).toBe(colour);
      expect(fx.stores.projects.get(project.id).colour).toBe(colour);
    }
  });

  it('preserves colour on unrelated edits and clears it only with null', async () => {
    const id = fx.ids.project;
    expect(fx.stores.projects.get(id).colour).toBeNull();
    const coloured = await request('PATCH', `/${id}`, { colour: '#12a6bc' });
    expect(coloured.status).toBe(200);
    expect(projectSchema.parse(await coloured.json()).colour).toBe('#12a6bc');

    const renamed = await request('PATCH', `/${id}`, {
      name: 'renamed',
      abbrev: 'NEW',
      archived: true,
    });
    expect(projectSchema.parse(await renamed.json())).toMatchObject({
      name: 'renamed',
      abbrev: 'NEW',
      archived: true,
      colour: '#12a6bc',
    });
    const listed = await app.request(`/api/projects?profile=${fx.ids.profile}`);
    expect(
      projectSchema
        .array()
        .parse(await listed.json())
        .find((p) => p.id === id)?.colour,
    ).toBe('#12a6bc');

    const cleared = await request('PATCH', `/${id}`, { colour: null });
    expect(projectSchema.parse(await cleared.json()).colour).toBeNull();
    expect(fx.stores.projects.get(id)).toMatchObject({ name: 'renamed', abbrev: 'NEW' });
  });

  it('rejects colours outside the palette without changing the saved value', async () => {
    await request('PATCH', `/${fx.ids.project}`, { colour: 'blue' });
    for (const colour of ['purple', '', 123, '#abc', '#aabbccdd', '#gggggg', 'rgb(1,2,3)']) {
      expect((await request('PATCH', `/${fx.ids.project}`, { colour })).status).toBe(400);
      expect(
        (
          await request('POST', '', {
            profile_id: fx.ids.profile,
            repo_id: fx.ids.repo,
            name: 'invalid',
            colour,
          })
        ).status,
      ).toBe(400);
    }
    expect(fx.stores.projects.get(fx.ids.project).colour).toBe('blue');
  });
});

describe('compact project catalogue', () => {
  it('matches session counts without materialising lists and omits private session/repository metadata', async () => {
    for (let i = 0; i < 100; i++) {
      fx.stores.sessions.create({
        id: crypto.randomUUID(),
        project_id: fx.ids.project,
        account_id: null,
        worktree_path: '/missing/catalogue-fixture',
        base_branch: 'main',
        branch: 'main',
        separate_branch: false,
        kind: 'terminal',
        agent_type: null,
        title: 'private session title',
        skip_permissions: false,
        status: i < 50 ? 'archived' : i < 75 ? 'running' : 'waiting_input',
      });
    }
    fx.stores.profiles.patchSettings(fx.ids.profile, { projectOrder: [fx.ids.project] });
    const full = JSON.stringify(fx.service.list());
    const list = vi.spyOn(fx.service, 'list').mockImplementation(() => {
      throw new Error('Full session list must not be read');
    });
    try {
      const response = await app.request(`/api/projects/catalogue?profile=${fx.ids.profile}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      const value = projectCatalogueSchema.parse(JSON.parse(text));
      expect(value.projects.find((entry) => entry.project.id === fx.ids.project)?.sessions).toEqual(
        { total: 50, running: 25, waiting_input: 25, interrupted: 0 },
      );
      expect(value.project_order[fx.ids.profile]).toEqual([fx.ids.project]);
      expect(text).not.toContain('private session title');
      expect(text).not.toContain('onboarding_notes');
      expect(text.length).toBeLessThan(full.length / 3);
      console.info(
        `Catalogue fixture: ${full.length} full session bytes; ${text.length} catalogue bytes for all projects`,
      );
    } finally {
      list.mockRestore();
    }
  });

  it('uses the lease-selected profile even if no explicit filter is supplied', async () => {
    const other = fx.stores.profiles.create({ name: 'catalogue-other', branch_prefix: '' });
    fx.stores.projects.create({
      name: 'other private project',
      profile_id: other.id,
      repo_id: fx.ids.repo,
    });
    const scoped = new Hono();
    scoped.use('*', async (c, next) => {
      c.set('remoteProfile', fx.ids.profile);
      await next();
    });
    scoped.route('/api/projects', projectRoutes({ ...fx.stores, ...fx, catalogue }));
    const value = projectCatalogueSchema.parse(
      await (await scoped.request('/api/projects/catalogue')).json(),
    );
    expect(value.projects.every((entry) => entry.project.profile_id === fx.ids.profile)).toBe(true);
    expect(value.project_order[other.id]).toBeUndefined();
  });
});
