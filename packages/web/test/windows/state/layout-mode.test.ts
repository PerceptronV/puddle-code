import { expect, it } from 'vitest';
import { WindowLayoutMode } from '../../../src/features/windows/state/layout-mode';

it('uses the preference for new seeds and the stored native mode after restoration or staging', () => {
  const mode = new WindowLayoutMode(true);
  expect(mode.select(true, false, 'profile', false)).toBe(true);
  expect(mode.select(true, true, 'profile', false)).toBe(false);
  expect(mode.select(true, false, 'profile', true)).toBe(false);
});

it('honours explicit preference changes across workspace remounts and releases the override after conversion', () => {
  const mode = new WindowLayoutMode(true);
  expect(mode.select(true, true, 'project', false)).toBe(true);
  expect(mode.select(false, true, 'project', false)).toBe(false);
  expect(mode.select(false, true, 'project', false)).toBe(false);
  expect(mode.select(false, true, 'profile', false)).toBe(false);
  expect(mode.select(false, true, 'project', true)).toBe(true);
  expect(mode.select(false, true, 'project', false)).toBe(true);
});

it('accepts a deliberate Settings action even when the stored default already has that value', () => {
  const mode = new WindowLayoutMode(true);
  expect(mode.select(true, true, 'profile', false)).toBe(false);
  mode.request(true);
  expect(mode.select(true, true, 'profile', false)).toBe(true);
  expect(mode.select(true, true, 'project', false)).toBe(true);
});
