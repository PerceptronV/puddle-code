import { describe, expect, it } from 'vitest';
import { huddleValueSchema } from '../../src/api/huddle/contracts.js';
import { huddleDefinitionSchema } from '../../src/api/huddle/definitions.js';
import { huddleComponentSchema } from '../../src/api/huddle/components.js';
import {
  canonicalHuddleJson,
  huddleIdSchema,
  huddleRelativePathSchema,
  isHuddleJson,
} from '../../src/api/huddle/values.js';
import {
  huddlePortCompatibility,
  validateHuddleValue,
} from '../../src/huddle/validation/values.js';
import { manualHuddleFixture, reviewHuddleFixture } from '../helpers/huddle.js';

describe('huddle document and value contracts', () => {
  it('uses random-hex identity and separate display names, and refuses future formats', () => {
    const definition = manualHuddleFixture();
    expect(huddleIdSchema.parse(definition.id)).toHaveLength(32);
    expect(huddleDefinitionSchema.parse({ ...definition, name: 'Renamed' }).id).toBe(definition.id);
    for (const id of ['review-loop', definition.id.toUpperCase(), '../' + definition.id, '1234'])
      expect(huddleIdSchema.safeParse(id).success).toBe(false);
    expect(huddleDefinitionSchema.safeParse({ ...definition, format: 2 }).success).toBe(false);
    expect(huddleDefinitionSchema.safeParse({ ...definition, future: true }).success).toBe(false);
  });

  it('bounds budgets and rejects path traversal before filesystem access', () => {
    expect(manualHuddleFixture().execution).toMatchObject({
      concurrency: 1,
      maxTurns: 50,
      maxAgents: 8,
      timeoutMs: 3_600_000,
    });
    for (const path of [
      '/tmp/code.ts',
      '../code.ts',
      './nodes/../../code.ts',
      'nodes\\code.ts',
      'nodes//code.ts',
      'nodes/./code.ts',
      'x\0.ts',
    ])
      expect(huddleRelativePathSchema.safeParse(path).success).toBe(false);
    expect(huddleRelativePathSchema.parse('./nodes/review/run.ts')).toBe('./nodes/review/run.ts');
    expect(
      huddleDefinitionSchema.safeParse({ ...manualHuddleFixture(), execution: { maxTurns: 0 } })
        .success,
    ).toBe(false);
  });

  it('rejects unsupported schema keywords and malformed contracts', () => {
    for (const schema of [
      { $ref: 'https://invalid/schema' },
      { type: 'string', pattern: '(a+)+$' },
      { type: 'mystery' },
      { minimum: 5, maximum: 2 },
      { required: ['missing'] },
    ])
      expect(huddleValueSchema.safeParse(schema).success).toBe(false);
    const component = reviewHuddleFixture().agent;
    expect(huddleComponentSchema.safeParse({ ...component, parameters: {} }).success).toBe(false);
    expect(huddleComponentSchema.safeParse({ ...component, category: 'trigger' }).success).toBe(
      false,
    );
  });

  it('enforces nested schemas without coercing approval or ignoring extra properties', () => {
    const schema = huddleValueSchema.parse({
      type: 'object',
      properties: {
        complete: { type: 'boolean' },
        notes: { type: ['array', 'null'], items: { type: 'string', maxLength: 4 }, maxItems: 2 },
      },
      required: ['complete'],
      additionalProperties: false,
    });
    expect(validateHuddleValue(schema, { complete: true, notes: ['😀😀'] })).toEqual([]);
    expect(validateHuddleValue(schema, { complete: false, notes: null })).toEqual([]);
    expect(validateHuddleValue(schema, { complete: 'yes' })).toEqual([
      { path: '/complete', message: 'Expected boolean' },
    ]);
    expect(validateHuddleValue(schema, { extra: true })).toHaveLength(2);
    expect(validateHuddleValue(schema, { complete: false, notes: ['12345'] })[0]?.path).toBe(
      '/notes/0',
    );
  });

  it('refuses cycles, excessive depth, non-JSON values and accessors without executing them', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    let deep: unknown = {};
    for (let i = 0; i < 30; i++) deep = { deep };
    let accessed = false;
    const getter = {
      get secret() {
        accessed = true;
        return 'no';
      },
    };
    for (const value of [
      cycle,
      deep,
      undefined,
      NaN,
      Infinity,
      1n,
      new Date(),
      getter,
      '界'.repeat(100_000),
      new Array(3),
    ])
      expect(isHuddleJson(value)).toBe(false);
    expect(accessed).toBe(false);
    expect(huddleValueSchema.safeParse(deep).success).toBe(false);
    const shared = { x: true };
    expect(isHuddleJson({ a: shared, b: shared })).toBe(true);
  });

  it('compares unordered JSON deterministically and never overclaims port compatibility', () => {
    expect(canonicalHuddleJson({ b: 2, a: 1 })).toBe(canonicalHuddleJson({ a: 1, b: 2 }));
    expect(huddlePortCompatibility({ type: 'string' }, { type: 'boolean' })).toBe('incompatible');
    expect(huddlePortCompatibility({ type: 'integer' }, { type: 'number', minimum: 0 })).toBe(
      'unknown',
    );
    expect(huddlePortCompatibility({}, { type: 'string' })).toBe('unknown');
    expect(huddlePortCompatibility({ enum: [1, 2] }, { type: 'number' })).toBe('compatible');
    expect(huddlePortCompatibility({ enum: [1, 'x'] }, { type: 'number' })).toBe('unknown');
    expect(huddlePortCompatibility({ enum: [false] }, { type: 'string' })).toBe('incompatible');
  });
});
