import type { Page } from '@playwright/test';

/** Unrelated application journeys read and close first-install notes as a user would. */
export async function dismissReleaseNotes(page: Page): Promise<void> {
  const notes = page.getByRole('dialog').filter({
    has: page.getByRole('navigation', { name: 'Release note sections', exact: true }),
  });
  await page.addLocatorHandler(notes, async (dialog) => {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  });
}
