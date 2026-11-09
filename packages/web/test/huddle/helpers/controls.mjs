/* global document */
import assert from 'node:assert/strict';

export async function chooseHuddleOption(trigger, choice) {
  await trigger.click();
  const options = trigger.page().getByRole('option');
  if (typeof choice === 'object' && 'label' in choice) {
    await trigger.page().getByRole('option', { name: choice.label, exact: true }).click();
  } else {
    const values = await options.evaluateAll((items) => items.map((item) => item.dataset.value));
    const index = values.indexOf(typeof choice === 'string' ? choice : choice.value);
    assert(index >= 0, `Missing dropdown choice: ${JSON.stringify(choice)}`);
    await options.nth(index).click();
  }
}
export async function huddleOptions(trigger) {
  await trigger.click();
  const items = await trigger
    .page()
    .getByRole('option')
    .evaluateAll((items) =>
      items.map((item) => ({ value: item.dataset.value, label: item.textContent })),
    );
  await trigger.press('Escape');
  return items;
}
export async function inspectNode(name) {
  const node = name.locator('xpath=ancestor::*[@data-huddle-node]');
  const bounds = await node.boundingBox();
  await node.click({ position: { x: bounds.width / 2, y: bounds.height - 6 } });
}
export async function expectDirty(editor, dirty) {
  await editor.page().waitForFunction((dirty) => {
    const save = document.querySelector('[aria-label="Huddle actions"] [aria-label="Save"]');
    return save && save.disabled !== dirty;
  }, dirty);
}
