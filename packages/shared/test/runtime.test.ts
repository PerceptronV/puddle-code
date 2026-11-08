import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  compatibleRuntimeProtocol,
  runtimeRequestSchema,
  runtimeLaunchSchema,
  parseRuntimeMessage,
  runtimeTurnResultSchema,
  RUNTIME_LIMITS,
  runtimeCaptureSchema,
  runtimeEnvDeltaSchema,
  runtimeRetainedEventSchema,
  runtimeAttentionSchema,
} from '../src/index.js';

const placement = { segment_id: randomUUID(), session_id: randomUUID() };

describe('private runtime protocol', () => {
  it('bounds current attention identity and fences preview reads to a placement', () => {
    const attention = {
      id: randomUUID(),
      segment_id: randomUUID(),
      reason: 'waiting_input',
      created_at: new Date().toISOString(),
    };
    expect(runtimeAttentionSchema.safeParse(attention).success).toBe(true);
    expect(
      runtimeAttentionSchema.safeParse({ ...attention, created_at: 'yesterday' }).success,
    ).toBe(false);
    const request = {
      t: 'attention-preview',
      id: randomUUID(),
      sequence: 1,
      placement,
      attention_id: attention.id,
    };
    expect(runtimeRequestSchema.safeParse(request).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({ ...request, placement: undefined }).success).toBe(
      false,
    );
    expect(runtimeRequestSchema.safeParse({ ...request, attention_id: 'any' }).success).toBe(false);
  });
  it('bounds colour reports and requires the exact placement for changes', () => {
    const request = {
      t: 'theme',
      id: randomUUID(),
      sequence: 1,
      placement,
      colours: { fg: '#123456', bg: '#abcdef' },
    };
    expect(runtimeRequestSchema.safeParse(request).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({ ...request, placement: undefined }).success).toBe(
      false,
    );
    expect(
      runtimeRequestSchema.safeParse({ ...request, colours: { fg: '#fff', bg: '#000000' } })
        .success,
    ).toBe(false);
    expect(
      runtimeRequestSchema.safeParse({ ...request, colours: { fg: '\x1b]10;?', bg: '#000000' } })
        .success,
    ).toBe(false);
  });
  it('bounds private shell observations and keeps capture policy explicit', () => {
    expect(
      runtimeCaptureSchema.safeParse({ enabled: true, values: { 'BAD=NAME': 'x' } }).success,
    ).toBe(false);
    expect(
      runtimeCaptureSchema.safeParse({
        enabled: true,
        values: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`N${i}`, 'x'])),
      }).success,
    ).toBe(false);
    expect(runtimeEnvDeltaSchema.safeParse({ op: 'set', name: 'A' }).success).toBe(false);
    expect(runtimeEnvDeltaSchema.safeParse({ op: 'set', name: 'A', value: 'x\0y' }).success).toBe(
      false,
    );
    expect(runtimeEnvDeltaSchema.safeParse({ op: 'set', name: 'A', value: '' }).success).toBe(true);
    expect(
      runtimeEnvDeltaSchema.safeParse({ op: 'set', name: 'A', value: '😀'.repeat(8193) }).success,
    ).toBe(false);
    expect(
      runtimeRequestSchema.safeParse({ t: 'capture-env', id: randomUUID(), sequence: 1 }).success,
    ).toBe(false);
    expect(
      runtimeRequestSchema.safeParse({ placement, t: 'clear-env', id: randomUUID(), sequence: 1 })
        .success,
    ).toBe(true);
    expect(
      runtimeRetainedEventSchema.safeParse({
        t: 'cwd',
        cursor: 1,
        term: 'agent',
        generation: randomUUID(),
        cwd: 'relative',
      }).success,
    ).toBe(false);
  });

  it('bounds turn prompts in UTF-8 bytes and requires an explicit native identity at admission', () => {
    const request = {
      placement,
      t: 'start-turn',
      id: randomUUID(),
      sequence: 1,
      turn: 1,
      expected_ref: null,
      prompt: 'question',
    };
    expect(runtimeRequestSchema.safeParse(request).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({ ...request, turn: 0 }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...request, expected_ref: undefined }).success).toBe(
      false,
    );
    expect(
      runtimeRequestSchema.safeParse({
        ...request,
        prompt: '😀'.repeat(RUNTIME_LIMITS.turnPromptBytes / 2),
      }).success,
    ).toBe(false);
    expect(
      runtimeRequestSchema.safeParse({
        ...request,
        output_schema: { description: 'x'.repeat(65536) },
      }).success,
    ).toBe(false);
  });

  it('rejects contradictory or oversized turn outcomes', () => {
    const result = { turn: 1, expected_ref: null, status: 'completed', reply: 'answer' };
    expect(runtimeTurnResultSchema.safeParse(result).success).toBe(true);
    expect(runtimeTurnResultSchema.safeParse({ ...result, reply: undefined }).success).toBe(false);
    expect(runtimeTurnResultSchema.safeParse({ ...result, status: 'running' }).success).toBe(false);
    expect(runtimeTurnResultSchema.safeParse({ ...result, error: 'failed' }).success).toBe(false);
    expect(
      runtimeTurnResultSchema.safeParse({
        ...result,
        reply: '😀'.repeat(RUNTIME_LIMITS.turnReplyBytes / 2),
      }).success,
    ).toBe(false);
  });
  it('ignores future additive messages while rejecting malformed known messages', () => {
    expect(parseRuntimeMessage({ t: 'future-event', value: 'optional' })).toBeNull();
    expect(() => parseRuntimeMessage({ t: 'exit', term: 'agent' })).toThrow();
    expect(() => parseRuntimeMessage({ t: 123 })).toThrow();
  });
  it('negotiates independently of release versions and accepts additive minors', () => {
    expect(RUNTIME_PROTOCOL_VERSION).toEqual({ major: 1, minor: 2 });
    expect(compatibleRuntimeProtocol({ major: 1, minor: 0 })).toBe(true);
    expect(compatibleRuntimeProtocol({ major: 1, minor: 99 })).toBe(true);
    expect(compatibleRuntimeProtocol({ major: 2, minor: 0 })).toBe(false);
    expect(compatibleRuntimeProtocol({ major: 0, minor: 99 })).toBe(false);
  });

  it('requires both terminal generation and monotonic command sequence for input', () => {
    const request = {
      placement,
      t: 'input',
      id: randomUUID(),
      sequence: 1,
      term: 'agent',
      generation: randomUUID(),
      data: 'hello\r',
      source: 'human',
    };
    expect(runtimeRequestSchema.parse({ ...request, future_optional_field: true })).toEqual(
      request,
    );
    expect(runtimeRequestSchema.safeParse({ ...request, generation: undefined }).success).toBe(
      false,
    );
    expect(runtimeRequestSchema.safeParse({ ...request, sequence: undefined }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...request, placement: undefined }).success).toBe(
      false,
    );
    expect(
      runtimeRequestSchema.safeParse({ ...request, placement: { session_id: randomUUID() } })
        .success,
    ).toBe(false);
    expect(
      runtimeRequestSchema.safeParse({ ...request, sequence: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...request, term: '../other-runtime' }).success).toBe(
      false,
    );
  });

  it('validates a private launch without accepting application session objects as identity', () => {
    const launch = {
      format: 1,
      identity: {
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
        profile_id: '1111111111',
        project_id: '2222222222',
        session_id: randomUUID(),
        canonical_worktree_path: '/tmp/worktree',
      },
      secret: '1'.repeat(64),
      main: {
        file: '/bin/sh',
        args: [],
        cwd: '/tmp/worktree',
        env: { PATH: '/usr/bin:/bin' },
        cols: 80,
        rows: 24,
      },
    };
    expect(runtimeLaunchSchema.parse(launch)).toEqual(launch);
    expect(
      runtimeLaunchSchema.safeParse({ ...launch, identity: { id: randomUUID() } }).success,
    ).toBe(false);
    expect(
      runtimeLaunchSchema.safeParse({ ...launch, main: { ...launch.main, cwd: 'relative' } })
        .success,
    ).toBe(false);
    expect(
      runtimeLaunchSchema.safeParse({
        ...launch,
        main: { ...launch.main, args: ['bad\0argument'] },
      }).success,
    ).toBe(false);
    expect(
      runtimeLaunchSchema.safeParse({
        ...launch,
        main: { ...launch.main, env: { 'BAD=NAME': 'x' } },
      }).success,
    ).toBe(false);
  });
});
