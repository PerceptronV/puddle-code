import { expect, it } from 'vitest';
import {
  HUDDLE_LIMITS,
  huddleDocumentSchema,
  huddleSourceSchema,
  huddleTextEditSchema,
  parseHuddleSource,
  huddleRevisionContent,
  canonicalHuddleJson,
} from '../../src/index.js';

const id = 'a'.repeat(32);
const text = JSON.stringify({ format: 1, id, name: 'Source', nodes: [], edges: [] });
const document = huddleDocumentSchema.parse({
  digest: 'b'.repeat(64),
  definition: JSON.parse(text),
  components: {},
  diagnostics: [],
});
const source = { document, files: { 'huddle.json': text } };

it('preserves raw source while validating strict current JSON and lossless UTF-8', () => {
  const content = ' \r\n\t' + text;
  expect(huddleTextEditSchema.parse({ file: 'huddle.json', content }).content).toBe(content);
  for (const content of [
    '{}',
    '\uFEFF' + text,
    text.replace('Source', '\uD800'),
    text.replace('"format":1', '"format":2'),
  ])
    expect(huddleTextEditSchema.safeParse({ file: 'huddle.json', content }).success).toBe(false);
  expect(huddleTextEditSchema.safeParse({ file: 'other.json', content: text }).success).toBe(false);
});

it('bounds source bytes/count/closure and requires a captured manifest', () => {
  expect(huddleSourceSchema.safeParse({ document, files: {} }).success).toBe(false);
  const check = (files: Record<string, string>) =>
    huddleSourceSchema.safeParse({ document, files: { ...source.files, ...files } }).success;
  expect(check({ 'script.ts': 'é'.repeat(HUDDLE_LIMITS.fileBytes / 2) })).toBe(true);
  expect(check({ 'script.ts': 'é'.repeat(HUDDLE_LIMITS.fileBytes / 2 + 1) })).toBe(false);
  expect(
    check(
      Object.fromEntries(Array.from({ length: HUDDLE_LIMITS.files }, (_, i) => [`s${i}.ts`, ''])),
    ),
  ).toBe(false);
  expect(
    check(
      Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [`s${i}.ts`, 'x'.repeat(HUDDLE_LIMITS.fileBytes)]),
      ),
    ),
  ).toBe(false);
  expect(check({ '../outside.ts': 'no' })).toBe(false);
  expect(check({ 'script.ts': '\uFEFF// preserve the script BOM' })).toBe(true);
});

it('binds parsed metadata to its exact source and preserves the existing revision encoding', () => {
  expect(parseHuddleSource(id, source)).toEqual(source);
  expect(() => parseHuddleSource('c'.repeat(32), source)).toThrow('another definition');
  expect(() =>
    parseHuddleSource(id, {
      ...source,
      document: { ...document, definition: { ...document.definition, name: 'Other' } },
    }),
  ).toThrow();
  expect(huddleRevisionContent(source.files, {})).toBe(
    canonicalHuddleJson({ format: 1, files: source.files, components: {} }),
  );
});
