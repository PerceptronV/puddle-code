import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { expect, it, vi } from 'vitest';
import {
  parseSignalBody,
  readSignalBody,
  RUNTIME_SIGNAL_BODY_BYTES,
} from '../../../../src/runtime/execution/signals/body.js';

it('retains a flat signal across arbitrarily fragmented Unicode and escapes', async () => {
  const body = { nonce: 'abcdefghijklmnop', event: 'turn_complete', reply: '🦆 café { [ \\ "' };
  const bytes = Buffer.from(JSON.stringify(body));
  const stream = Readable.from([...bytes].map((byte) => Buffer.from([byte])));
  expect(await readSignalBody(stream as IncomingMessage)).toEqual(body);
});

it('rejects overlarge bodies and nested or excessive structure before JSON parsing', async () => {
  const parse = vi.spyOn(JSON, 'parse');
  try {
    const stream = Readable.from([Buffer.alloc(RUNTIME_SIGNAL_BODY_BYTES + 1)]);
    await expect(readSignalBody(stream as IncomingMessage)).rejects.toThrow('body exceeds');
    expect(() => parseSignalBody('{"unused":[[[[]]]]}')).toThrow('structure');
    expect(() => parseSignalBody('{"unused":{"nested":true}}')).toThrow('structure');
    const many = '{' + Array.from({ length: 33 }, (_, index) => `"${index}":null`).join(',') + '}';
    expect(() => parseSignalBody(many)).toThrow('structure');
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});
