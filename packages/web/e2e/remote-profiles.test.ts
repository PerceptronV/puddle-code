import { test, expect, type Page } from '@playwright/test';
import { projectSchema, projectDetailSchema, profileSchema } from '@puddle/shared';
import { mobileFixture } from './mobile-fixture';

test('keeps two remote accounts on one host scoped to their own profiles', async ({ browser }) => {
  const fixture = await mobileFixture();
  const first = await browser.newContext({ ignoreHTTPSErrors: true });
  const second = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const { project: original } = projectDetailSchema.parse(
      await (await fixture.local.req(`/api/projects/${fixture.session.project_id}`)).json(),
    );
    const profile = profileSchema.parse(
      await (
        await fixture.local.req('/api/profiles', {
          method: 'POST',
          body: JSON.stringify({ name: 'second-profile' }),
        })
      ).json(),
    );
    const project = projectSchema.parse(
      await (
        await fixture.local.req('/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Second profile project',
            profile_id: profile.id,
            repo_id: original.repo_id,
          }),
        })
      ).json(),
    );
    expect(
      (
        await fixture.local.req('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ project_id: project.id, kind: 'terminal', title: 'Second shell' }),
        })
      ).ok,
    ).toBe(true);

    const connect = async (page: Page, email: string, scope: string, name: string) => {
      await page.route('https://github.com/login/oauth/authorize?**', (route) =>
        route.fulfill({
          status: 302,
          headers: { location: fixture.github.callback(route.request().url(), { email }) },
        }),
      );
      await page.goto(fixture.appOrigin);
      await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
      await expect(page.getByRole('main', { name: 'Hosts and projects' })).toBeVisible();
      const cookie = (await page.context().cookies(fixture.serviceOrigin))
        .map((entry) => `${entry.name}=${entry.value}`)
        .join('; ');
      const account = await fixture.remote.auth.authorised(new Headers({ cookie }));
      expect(account).not.toBeNull();
      await fixture.enable(account!.user.id, undefined, scope);
      const invitation = await fixture.admin({ t: 'pair' }, scope);
      await page.goto(invitation.url!);
      await page.getByLabel('Browser name').fill(name);
      await page.getByRole('button', { name: 'Request host approval' }).click();
      await expect(page.getByRole('status')).toContainText('Waiting for host approval');
      const device = (await fixture.admin({ t: 'devices' }, scope)).devices!.find(
        (entry) => entry.status === 'pending',
      )!;
      await fixture.admin({ t: 'approve', id: device.id }, scope);
      await expect(page.getByRole('status')).toHaveText('Connected');
      return device;
    };

    const one = await first.newPage();
    const two = await second.newPage();
    const browserOne = await connect(one, 'first@example.test', fixture.profile, 'First browser');
    await connect(two, 'second@example.test', profile.id, 'Second browser');
    await expect(one.getByRole('button', { name: 'Open fixture', exact: true })).toBeVisible();
    await expect(one.getByText(project.name, { exact: true })).toHaveCount(0);
    await expect(
      two.getByRole('button', { name: `Open ${project.name}`, exact: true }),
    ).toBeVisible();
    await expect(two.getByRole('button', { name: 'Open fixture', exact: true })).toHaveCount(0);
    await one.getByRole('button', { name: 'Open fixture', exact: true }).click();
    await two.getByRole('button', { name: `Open ${project.name}`, exact: true }).click();
    await expect(two.getByRole('button', { name: 'Switch session', exact: true })).toContainText(
      'Second shell',
    );

    await fixture.admin({ t: 'revoke', id: browserOne.id });
    await expect(one.getByRole('status')).toHaveText('Pairing required or access revoked');
    await fixture.admin({ t: 'delete_registration' });
    await expect(two.getByRole('status')).toHaveText('Connected');
    await expect(two.getByRole('button', { name: 'Enter', exact: true })).toBeEnabled();
    expect(await fixture.admin({ t: 'status' }, profile.id)).toMatchObject({
      enabled: true,
      connected: true,
    });
    expect((await fixture.local.req(`/api/sessions/${fixture.session.id}`)).ok).toBe(true);
  } finally {
    await first.close();
    await second.close();
    await fixture.close();
  }
});
