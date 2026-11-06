import { expect, it } from 'vitest';
import { HOST_ICONS } from '../../../src/features/host/host-icons';
import { PROFILE_ICONS } from '../../../src/features/profile/profile-icons';

it('offers as many distinct host icons as profile icons without overlap', () => {
  const host = HOST_ICONS.map(({ name }) => name);
  expect(host).toHaveLength(PROFILE_ICONS.length);
  expect(new Set(host).size).toBe(host.length);
  expect(host.filter((name) => PROFILE_ICONS.some((icon) => icon.name === name))).toEqual([]);
  expect(HOST_ICONS.every(({ Icon }) => Boolean(Icon))).toBe(true);
});
