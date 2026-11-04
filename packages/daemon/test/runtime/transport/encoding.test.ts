import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_LIMITS } from '@puddle/shared';
import { encodeRuntimeFrame } from '../../../src/runtime/transport/framing.js';
import { RUNTIME_JSON_LIMITS, runtimeJsonBytes } from '../../../src/runtime/transport/encoding.js';

function matchesJson(value: unknown): void {
  const json = JSON.stringify(value);
  const frame = encodeRuntimeFrame(value);
  expect(runtimeJsonBytes(value)).toBe(Buffer.byteLength(json));
  expect(frame.readUInt32BE()).toBe(frame.length - 4);
  expect(frame.subarray(4).toString('utf8')).toBe(json);
}

describe('bounded runtime JSON encoding', () => {
  it('matches Unicode, escaping and all UTF-16 code units including lone surrogates', () => {
    const units = Array.from({ length: 65_536 }, (_, unit) => String.fromCharCode(unit)).join('');
    matchesJson({ text: units, '"\\\n🦆\ud800': '\ud800a\udc00🦆\ud800\ud800' });
    matchesJson({ text: 'escape \b\f\n\r\t\u0000\u001f and café 漢字 🦆' });
  });

  it('preserves plain JSON omission, sparse arrays, non-finite numbers and shared children', () => {
    const child = Object.assign(Object.create(null) as Record<string, unknown>, {
      text: 'shared',
      absent: undefined,
    });
    const sparse: unknown[] = new Array(4);
    sparse[1] = undefined;
    sparse[3] = child;
    Object.defineProperty(sparse, 2, { value: NaN, enumerable: false });
    matchesJson({ child, again: child, sparse, values: [-0, Infinity, -Infinity, 1e100, 1e-9] });
    for (const value of [null, true, false, 0, 'text']) matchesJson(value);
    matchesJson({ toJSON: 'ordinary data', absent: undefined });
  });

  it('refuses oversize text before JSON serialisation or frame allocation', () => {
    const value = { text: '\u0000'.repeat(Math.ceil(RUNTIME_LIMITS.frameBytes / 6)) };
    const stringify = vi.spyOn(JSON, 'stringify');
    const allocate = vi.spyOn(Buffer, 'allocUnsafe');
    try {
      expect(() => encodeRuntimeFrame(value)).toThrow('byte limit');
      expect(stringify).not.toHaveBeenCalled();
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
      allocate.mockRestore();
    }
  });

  it('refuses getters, custom serialisers, proxies and non-plain objects without executing them', () => {
    const execute = vi.fn(() => 'unexpected');
    const accessor = Object.defineProperty({}, 'value', { get: execute, enumerable: true });
    const hidden = Object.defineProperty({}, 'toJSON', { value: execute });
    const array = Object.defineProperty([0], 0, { get: execute });
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          execute();
          return [];
        },
      },
    );
    const values = [accessor, hidden, array, proxy, new Date(0), Buffer.from('not wire JSON')];
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      for (const value of values)
        expect(() => encodeRuntimeFrame(value)).toThrow('plain schema JSON');
      expect(execute).not.toHaveBeenCalled();
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it('bounds omitted-key traversal, deep nesting and cycles before serialisation', () => {
    const keys = Object.fromEntries(
      Array.from({ length: RUNTIME_JSON_LIMITS.values }, (_, index) => [String(index), undefined]),
    );
    let deep: unknown = null;
    for (let index = 0; index < RUNTIME_JSON_LIMITS.depth + 1; index++) deep = [deep];
    let sparse: unknown = new Array(1);
    for (let index = 0; index < RUNTIME_JSON_LIMITS.depth; index++) sparse = [sparse];
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(() => encodeRuntimeFrame(keys)).toThrow('traversal capacity');
      expect(() => encodeRuntimeFrame(deep)).toThrow('depth capacity');
      expect(() => encodeRuntimeFrame(sparse)).toThrow('depth capacity');
      expect(() => encodeRuntimeFrame(cycle)).toThrow('cycle');
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });
});
