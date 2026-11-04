import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { runtimeRequestSchema } from '@puddle/shared';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import { RuntimeTransportBuffers } from '../../../src/runtime/transport/buffers.js';
import { runtimeJsonDecodeBytes } from '../../../src/runtime/transport/decoding.js';
import {
  RUNTIME_JSON_LIMITS,
  runtimeJsonBytes,
  runtimeJsonRetainedBytes,
} from '../../../src/runtime/transport/encoding.js';
import { readRuntimeFrames } from '../../../src/runtime/transport/framing.js';
import { RuntimeRequestQueue } from '../../../src/runtime/transport/requests.js';

function frame(json: string): Buffer {
  const body = Buffer.from(json);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

describe('runtime decode admission', () => {
  it('preserves ordinary JSON, escaped strings and multi-byte text without counting quoted structure', () => {
    const values: unknown[] = [
      { text: '"\\[]{}: false null 1 café 漢字 🦆\ud800\udc00', empty: [] },
      { control: '\n\r\t\u0000', '\\"quoted-key': true },
      [null, true, false, -1.2e100, 0, { value: [] }],
      'top-level string',
      1,
    ];
    const socket = new Socket();
    const got: unknown[] = [];
    const failed = vi.fn();
    const stop = readRuntimeFrames(socket, (value) => got.push(value), failed);
    try {
      for (const value of values) {
        const json = ` \r\n${JSON.stringify(value)}\t `;
        expect(runtimeJsonDecodeBytes(Buffer.from(json))).toBeGreaterThan(json.length);
        socket.emit('data', frame(json));
      }
      expect(got).toEqual(values);
      expect(failed).not.toHaveBeenCalled();
    } finally {
      stop();
      socket.destroy();
    }
  });

  it('matches the sender depth boundary for deepest containers and primitive leaves', () => {
    for (const leaf of [[], null]) {
      let value: unknown = leaf;
      for (let depth = 0; depth < RUNTIME_JSON_LIMITS.depth; depth++) value = [value];
      expect(() => runtimeJsonBytes(value)).not.toThrow();
      expect(() => runtimeJsonDecodeBytes(Buffer.from(JSON.stringify(value)))).not.toThrow();
      value = [value];
      expect(() => runtimeJsonBytes(value)).toThrow('depth capacity');
      expect(() => runtimeJsonDecodeBytes(Buffer.from(JSON.stringify(value)))).toThrow(
        'depth capacity',
      );
    }
  });

  it('matches sender traversal limits for tiny array values and object keys', () => {
    const array = Array.from({ length: RUNTIME_JSON_LIMITS.values - 1 }, () => 0);
    const object = Object.fromEntries(
      Array.from({ length: (RUNTIME_JSON_LIMITS.values - 2) / 2 }, (_, index) => [`k${index}`, 0]),
    );
    for (const value of [array, object]) {
      expect(() => runtimeJsonBytes(value)).not.toThrow();
      expect(() => runtimeJsonDecodeBytes(Buffer.from(JSON.stringify(value)))).not.toThrow();
    }
    array.push(0);
    object.extra = 0;
    for (const value of [array, object]) {
      expect(() => runtimeJsonBytes(value)).toThrow('traversal capacity');
      expect(() => runtimeJsonDecodeBytes(Buffer.from(JSON.stringify(value)))).toThrow(
        'traversal capacity',
      );
    }
  });

  it.each(['depth', 'values', 'allowance'] as const)(
    'rejects %s pressure before UTF-8 decoding or JSON.parse',
    (kind) => {
      const json =
        kind === 'depth'
          ? '['.repeat(RUNTIME_JSON_LIMITS.depth + 1) +
            '0' +
            ']'.repeat(RUNTIME_JSON_LIMITS.depth + 1)
          : kind === 'values'
            ? '[' + '0,'.repeat(RUNTIME_JSON_LIMITS.values) + '0]'
            : '{"text":"refused"}';
      const bytes = frame(json);
      const allowance = new RuntimeBufferBudget({
        bytes: kind === 'allowance' ? bytes.length : 128 * 1024 * 1024,
        count: 8,
      });
      const buffers = new RuntimeTransportBuffers(allowance);
      const socket = new Socket();
      const received = vi.fn();
      const failed = vi.fn();
      const stop = readRuntimeFrames(socket, received, failed, buffers.incoming, buffers.decoding);
      const decode = vi.spyOn(TextDecoder.prototype, 'decode');
      const parse = vi.spyOn(JSON, 'parse');
      try {
        socket.emit('data', bytes);
        expect(decode).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
        expect(received).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledOnce();
        expect(allowance.usedBytes).toBe(0);
      } finally {
        decode.mockRestore();
        parse.mockRestore();
        stop();
        socket.destroy();
      }
    },
  );

  it.each(['return', 'throw'] as const)(
    'holds receive credit across synchronous stop and callback %s',
    (result) => {
      const allowance = new RuntimeBufferBudget({ bytes: 1024 * 1024, count: 8 });
      const buffers = new RuntimeTransportBuffers(allowance);
      const socket = new Socket();
      const json = '{"text":"held"}';
      const body = Buffer.from(json);
      const charged = body.length + runtimeJsonDecodeBytes(body);
      const failed = vi.fn();
      const stop = readRuntimeFrames(
        socket,
        () => {
          expect(allowance.usedBytes).toBe(charged);
          stop();
          expect(allowance.usedBytes).toBe(charged);
          if (result === 'throw') throw new Error('schema failed');
        },
        failed,
        buffers.incoming,
        buffers.decoding,
      );
      try {
        socket.emit('data', frame(json));
        expect(failed).toHaveBeenCalledTimes(result === 'throw' ? 1 : 0);
        expect(allowance.usedBytes).toBe(0);
        expect(allowance.usedCount).toBe(0);
      } finally {
        stop();
        socket.destroy();
      }
    },
  );

  it('transfers a schema-validated request into retained queue credit before receive returns', async () => {
    const allowance = new RuntimeBufferBudget({ bytes: 1024 * 1024, count: 8 });
    const buffers = new RuntimeTransportBuffers(allowance);
    const requests = new RuntimeBufferBudget({ bytes: 1024 * 1024, count: 64 }, allowance);
    const socket = new Socket();
    const failed = vi.fn();
    const queue = new RuntimeRequestQueue(requests, () => true, failed);
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const value = { t: 'inspect', id: randomUUID(), sequence: 1 };
    const json = JSON.stringify(value);
    let retained = 0;
    const stop = readRuntimeFrames(
      socket,
      (decoded) => {
        const request = runtimeRequestSchema.parse(decoded);
        retained = runtimeJsonRetainedBytes(request);
        expect(retained).toBeGreaterThan(2 * Buffer.byteLength(json));
        expect(queue.enqueue(retained, () => wait)).toBe(true);
        expect(allowance.usedBytes).toBe(
          Buffer.byteLength(json) + runtimeJsonDecodeBytes(Buffer.from(json)) + retained,
        );
      },
      failed,
      buffers.incoming,
      buffers.decoding,
    );
    try {
      socket.emit('data', frame(json));
      expect(failed).not.toHaveBeenCalled();
      expect(retained).toBeGreaterThan(0);
      expect(allowance.usedBytes).toBe(retained);
      stop();
      expect(allowance.usedBytes).toBe(retained);
      finish();
      await queue.settled;
      expect(allowance.usedBytes).toBe(0);
    } finally {
      finish();
      await queue.settled;
      stop();
      socket.destroy();
    }
  });

  it('keeps admission through an oversized output-schema validation and releases its failure', () => {
    const value = {
      t: 'start-turn',
      id: randomUUID(),
      sequence: 1,
      turn: 1,
      expected_ref: null,
      placement: { segment_id: randomUUID(), session_id: randomUUID() },
      prompt: 'bounded',
      output_schema: { description: 'x'.repeat(512 * 1024) },
    };
    const json = JSON.stringify(value);
    const bytes = frame(json);
    const charged = Buffer.byteLength(json) + runtimeJsonDecodeBytes(Buffer.from(json));
    const allowance = new RuntimeBufferBudget({ bytes: charged, count: 8 });
    const buffers = new RuntimeTransportBuffers(allowance);
    const socket = new Socket();
    const failed = vi.fn();
    const stop = readRuntimeFrames(
      socket,
      (decoded) => {
        runtimeRequestSchema.parse(decoded);
      },
      failed,
      buffers.incoming,
      buffers.decoding,
    );
    const encode = TextEncoder.prototype.encode;
    let validated = false;
    const validation = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      this: TextEncoder,
      value,
    ) {
      if (value && value.length > 64 * 1024) {
        validated = true;
        expect(allowance.usedBytes).toBe(charged);
      }
      return encode.call(this, value);
    });
    try {
      socket.emit('data', bytes);
      expect(validated).toBe(true);
      expect(failed).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Output schema exceeds') }),
      );
      expect(allowance.usedBytes).toBe(0);
    } finally {
      validation.mockRestore();
      stop();
      socket.destroy();
    }
  });
});
