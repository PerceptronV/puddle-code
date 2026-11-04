import { expect, it } from 'vitest';
import { RELEASE_NOTES_MAX_BYTES, releaseNotesSchema } from '../../src/index.js';

it('bounds public notes by component, record count and UTF-8 size', () => {
  const note = { component: 'daemon', version: '0.4.0', markdown: '# Notes' };
  expect(
    releaseNotesSchema.parse({ releases: [note, { ...note, component: 'runtime' }] }).releases,
  ).toHaveLength(2);
  expect(releaseNotesSchema.safeParse({ releases: [note, note] }).success).toBe(false);
  expect(releaseNotesSchema.safeParse({ releases: [note, note, note] }).success).toBe(false);
  expect(
    releaseNotesSchema.safeParse({ releases: [{ ...note, component: 'cockpit' }] }).success,
  ).toBe(false);
  expect(
    releaseNotesSchema.safeParse({
      releases: [{ ...note, markdown: 'é'.repeat(RELEASE_NOTES_MAX_BYTES / 2 + 1) }],
    }).success,
  ).toBe(false);
  expect(
    releaseNotesSchema.safeParse({
      releases: [{ ...note, markdown: 'x'.repeat(RELEASE_NOTES_MAX_BYTES) }],
    }).success,
  ).toBe(true);
});
