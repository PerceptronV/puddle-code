import { test, expect, type Page } from '@playwright/test';
import { PROTOCOL_VERSION, projectSchema, sessionSchema } from '@puddle/shared';
import { startPairingFixture, mockPairingAccount, service, account, host } from './pairing-fixture';

let fixture: Awaited<ReturnType<typeof startPairingFixture>>;
const otherHost = '00000000-0000-4000-8000-000000000002';
const projectA = '1000000001';
const projectB = '1000000002';
const sessionA = '20000000-0000-4000-8000-000000000001';
const sessionB = '20000000-0000-4000-8000-000000000002';
const stamp = '2026-01-01T00:00:00Z';
const projects = [projectA, projectB].map((id, i) =>
  projectSchema.parse({
    id,
    profile_id: '0123456789',
    repo_id: 1,
    name: `Project ${i + 1}`,
    created_at: stamp,
    updated_at: stamp,
  }),
);
const sessions = [sessionA, sessionB].map((id, i) =>
  sessionSchema.parse({
    id,
    project_id: projects[i]!.id,
    account_id: 1,
    worktree_path: '/project',
    base_branch: 'main',
    branch: 'main',
    separate_branch: false,
    kind: 'agent',
    agent_type: 'codex',
    agent_session_ref: id,
    title: `Conversation ${i + 1}`,
    status: 'waiting_input',
    skip_permissions: false,
    created_at: stamp,
    updated_at: stamp,
    last_activity_at: stamp,
    ended_at: null,
  }),
);

test.beforeAll(async () => {
  fixture = await startPairingFixture();
});
test.afterAll(async () => {
  await fixture?.server.close();
});
test.use({ hasTouch: true, isMobile: true });

async function prepare(page: Page) {
  await mockPairingAccount(page);
  await page.route(`${service}/remote/hosts`, (route) =>
    route.fulfill({
      json: [
        { id: host, label: 'First host', online: false },
        { id: otherHost, label: 'Second host', online: false },
      ],
    }),
  );
  // Keep the real RemoteApp/ConnectedHost/PhoneWorkspace and replace only the
  // admitted transport. No daemon, installed agents or push vendor is involved.
  await page.route('**/src/features/remote/client.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
    const projects = ${JSON.stringify(projects)};
    const sessions = ${JSON.stringify(sessions)};
    export class RemoteClient {
      state = 'idle'; generation = 'test'; listeners = new Set();
      constructor(host) { this.host = host; this.scope = host.host; this.notificationHost = host.host; }
      onState(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
      start() { this.state = 'ready'; for (const listener of this.listeners) listener(); }
      close() { this.state = 'closed'; }
      async request(method, path) {
        let data = {};
        if (path === '/api/projects') data = projects;
        else if (path === '/api/sessions') data = sessions;
        else if (path === '/api/repos' || path === '/api/accounts' || path === '/api/profiles') data = [];
        else if (path.endsWith('/state')) data = { ui_state: {} };
        else if (path === '/api/host') data = { hostname: 'Test host' };
        else if (path === '/api/version') data = { version: 'test', protocol: ${JSON.stringify(PROTOCOL_VERSION)} };
        return Response.json(data);
      }
      socket() { const socket = new EventTarget(); socket.readyState = 1; socket.send = () => {}; socket.close = () => {}; setTimeout(() => socket.dispatchEvent(new Event('open')), 0); return socket; }
      async input() {}
    }
  `,
    }),
  );
  await page.goto(fixture.origin);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await page.evaluate(
    async ({ service, account, hosts }) => {
      const url = new URL('/src/features/remote/identity-store.ts', location.origin).href;
      const { saveBrowserHost } = await import(url);
      for (const host of hosts)
        await saveBrowserHost({
          host,
          service,
          account,
          peer: 'A'.repeat(44),
          label: 'Test device',
          privateKey: Array(32).fill(1),
        });
    },
    { service, account, hosts: [host, otherHost] },
  );
}

async function clickNotification(
  page: Page,
  target: { host: string; project: string; session: string },
) {
  await page.evaluate(
    (target) =>
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          data: { t: 'notification-click', id: crypto.randomUUID(), host: target.host, target },
        }),
      ),
    target,
  );
}

test('mobile notification clicks select exact sessions across projects, hosts and cold starts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await prepare(page);
  await page.goto(
    `${fixture.origin}/?notificationHost=${host}&notificationProject=${projectA}&notificationSession=${sessionA}`,
  );
  await expect(page.getByRole('button', { name: 'Switch session' })).toHaveText('Conversation 1');
  await page.getByRole('button', { name: 'Paired browsers', exact: true }).tap();
  await expect(page.getByRole('dialog', { name: 'Paired browsers' })).toBeVisible();
  await clickNotification(page, { host, project: projectA, session: sessionA });
  await expect(page.getByRole('dialog', { name: 'Paired browsers' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Files', exact: true }).tap();
  await clickNotification(page, { host, project: projectB, session: sessionB });
  await expect(page.getByRole('button', { name: 'Switch session' })).toHaveText('Conversation 2');
  await clickNotification(page, { host: otherHost, project: projectA, session: sessionA });
  await expect(page.getByRole('button', { name: 'Back to all projects' })).toHaveText(
    'Second host/Project 1',
  );
  await expect(page.getByRole('button', { name: 'Switch session' })).toHaveText('Conversation 1');
  await clickNotification(page, {
    host: otherHost,
    project: projectA,
    session: '20000000-0000-4000-8000-000000000099',
  });
  await expect(
    page.getByText('This conversation is no longer available.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch session' })).toHaveText('No sessions');
  expect(errors).toEqual([]);
});

test('keeps a cold notification destination through the sign-in redirect', async ({ page }) => {
  await prepare(page);
  await page.route(`${service}/remote/me`, (route) =>
    route.fulfill({ json: { user: null, mfaRequired: false } }),
  );
  let callback = '';
  await page.route(`${service}/api/auth/sign-in/social`, async (route) => {
    callback = route.request().postDataJSON().callbackURL;
    await route.fulfill({ status: 400, json: { message: 'Fixture stops at the OAuth boundary' } });
  });
  const destination = `${fixture.origin}/?notificationHost=${host}&notificationProject=${projectA}&notificationSession=${sessionA}`;
  await page.goto(destination);
  await page.getByRole('button', { name: 'Continue with GitHub' }).tap();
  await expect.poll(() => callback).toBe(destination);
});
