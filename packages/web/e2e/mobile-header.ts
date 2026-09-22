import { expect, type Page, type TestInfo } from '@playwright/test';
import { sessionSchema, type Project } from '@puddle/shared';
import type { mobileFixture } from './mobile-fixture';

export async function saveDesktopOrder(
  fixture: Awaited<ReturnType<typeof mobileFixture>>,
  original: Project,
  second: Project,
) {
  const terminal = sessionSchema.parse(
    await (
      await fixture.local.req('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          project_id: original.id,
          kind: 'terminal',
          title: 'Project terminal',
          separate_branch: false,
        }),
      })
    ).json(),
  );
  for (const [path, method, body] of [
    [`/api/projects/${second.id}`, 'PATCH', { abbrev: 'WWWWW' }],
    [`/api/sessions/${fixture.session.id}`, 'PATCH', { title: 'Active agent' }],
    [
      `/api/profiles/${original.profile_id}/settings`,
      'PATCH',
      { projectOrder: [original.id, second.id] },
    ],
    [
      `/api/profiles/${original.profile_id}/state`,
      'PUT',
      { ui_state: { session_order: [fixture.session.id, terminal.id] } },
    ],
  ] as const) {
    const response = await fixture.local.req(path, { method, body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
  }
}

export async function checkMobileHeader(page: Page, testInfo: TestInfo) {
  const breadcrumb = page.getByRole('button', { name: 'Back to all projects', exact: true });
  await expect(breadcrumb).toHaveText('Fixture host/fixture');
  await expect(page.getByRole('button', { name: 'Switch project', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Terminals', exact: true })).toHaveCount(0);
  const rail = page.getByRole('complementary', { name: 'Sessions' });
  const projectLabels = rail.getByRole('button', { name: /^Switch to / });
  await expect(projectLabels).toHaveText(['FIXTU', 'WWWWW']);
  await page.evaluate(() => document.fonts.ready);
  for (const label of await projectLabels.all()) {
    expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  await expectToolbarAlignment(page);
  await expect
    .poll(() =>
      rail
        .getByRole('button', { name: /^Open session / })
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    )
    .toEqual(['Open session Active agent', 'Open session Project terminal']);
  const controls = await Promise.all(
    ['Expand sessions', 'New agent', 'New terminal'].map(
      async (name) => (await rail.getByRole('button', { name, exact: true }).boundingBox())!,
    ),
  );
  expect(controls[2]!.y - controls[0]!.y).toBeLessThanOrEqual(76);
  await expect(
    rail.getByRole('button', { name: 'New agent', exact: true }).locator('svg'),
  ).toHaveClass(/lucide-bot/);
  const gold = await rail.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--text-gold)';
    element.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  // Hover changes desktop-style controls to primary ink; inspect them at rest.
  for (const name of ['Expand sessions', 'New agent', 'New terminal', 'Archived sessions']) {
    await expect(rail.getByRole('button', { name, exact: true }).locator('svg')).toHaveCSS(
      'color',
      gold,
    );
  }

  const selector = page.getByRole('button', { name: 'Switch session', exact: true });
  await expect(selector).toContainText('Active agent');
  await expect(
    page.locator('.phone-terminal-title').getByRole('button', { name: 'Session details' }),
  ).toBeVisible();
  await selector.tap();
  const menu = page.getByRole('menu', { name: 'Switch session' });
  await expect(menu.getByRole('menuitemcheckbox')).toHaveText(['Active agent', 'Project terminal']);
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Active agent' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.screenshot({ path: testInfo.outputPath('phone-session-switcher.png') });
  await menu.getByRole('menuitemcheckbox', { name: /Project terminal$/ }).tap();
  await expect(selector).toContainText('Project terminal');
  await expect(
    rail.getByRole('button', { name: 'Open session Project terminal', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Session details' }).click();
  await expect(page.getByRole('button', { name: 'Add shell', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archive session', exact: true }).click();
  await expect(selector).toContainText('Active agent');
  await selector.click();
  await expect(menu.getByRole('menuitemcheckbox')).toHaveText(['Active agent']);
  await page.keyboard.press('Escape');

  // The host/project breadcrumb returns to the host-grouped home cards directly.
  await breadcrumb.click();
  await expect(page.getByRole('main', { name: 'Hosts and projects' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Fixture host' }).getByRole('button', { name: /^Open / }),
  ).toHaveText([/fixture/, /Second project/]);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toHaveCount(0);
  await expect(page.getByText('Your workspace, wherever you are.', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Puddle Remote', exact: true }).locator('svg'),
  ).toBeVisible();
  const disclosure = page.getByRole('region', { name: 'Fixture host' }).locator('summary');
  await disclosure.click();
  await expect(page.getByRole('button', { name: 'Open fixture', exact: true })).toBeHidden();
  await disclosure.press('Space');
  await expect(page.getByRole('button', { name: 'Open fixture', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open fixture', exact: true }).click();
  await expect(breadcrumb).toHaveText('Fixture host/fixture');
}

export async function checkFileToolbar(page: Page, testInfo: TestInfo) {
  const toolbar = page.getByRole('navigation', { name: 'Workspace view' });
  await expect(toolbar.getByRole('button', { name: 'Files', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch session', exact: true })).toHaveCount(0);
  const buttons = [
    'Parent directory',
    'Open file or directory',
    'Review changes',
    'Refresh files',
    'Terminals',
  ];
  const rows = await Promise.all(
    buttons.map(
      async (name) => (await toolbar.getByRole('button', { name, exact: true }).boundingBox())!.y,
    ),
  );
  expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1);
  await expectToolbarAlignment(page);
  await expect(
    toolbar.getByRole('button', { name: 'Terminals', exact: true }).locator('svg'),
  ).toHaveClass(/lucide-monitor/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Select file review.html', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Choose a PNG, JPEG, GIF or WebP image.', { exact: true }),
  ).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('phone-file-toolbar.png') });
}

async function expectToolbarAlignment(page: Page) {
  const bar = (await page.getByRole('navigation', { name: 'Workspace view' }).boundingBox())!;
  const toggle = (await page
    .getByRole('button', { name: 'Expand sessions', exact: true })
    .boundingBox())!;
  expect(Math.abs(bar.y + bar.height / 2 - (toggle.y + toggle.height / 2))).toBeLessThanOrEqual(1);
}
