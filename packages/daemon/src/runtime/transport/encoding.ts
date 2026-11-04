import { types } from 'node:util';
import { RUNTIME_LIMITS } from '@puddle/shared';

/** Bounds traversal work independently of encoded bytes, including omitted properties. */
export const RUNTIME_JSON_LIMITS = Object.freeze({ depth: 128, values: 65_536 });

/**
 * Count schema JSON without constructing its serialised string or a body buffer.
 * Accessors, proxies and custom objects cannot execute code between sizing and
 * serialisation. Shared children are valid; only ancestors constitute a cycle.
 */
export function runtimeJsonBytes(value: unknown): number {
  return runtimeJsonSize(value).bytes;
}

/** Strings and bounded schema-object metadata retained by an admitted request closure. */
export function runtimeJsonRetainedBytes(value: unknown): number {
  const size = runtimeJsonSize(value);
  return 2 * size.bytes + 128 * size.values + 1024;
}

function runtimeJsonSize(value: unknown): { bytes: number; values: number } {
  let bytes = 0;
  let values = 0;
  const ancestors = new Set<object>();
  const add = (count: number) => {
    bytes += count;
    if (bytes > RUNTIME_LIMITS.frameBytes) throw new Error('Runtime frame exceeds its byte limit');
  };
  const visit = (depth?: number) => {
    if (++values > RUNTIME_JSON_LIMITS.values)
      throw new Error('Runtime JSON traversal capacity exceeded');
    if (depth !== undefined && depth > RUNTIME_JSON_LIMITS.depth)
      throw new Error('Runtime JSON depth capacity exceeded');
  };
  // JSON must escape these control characters; the scan intentionally matches them.
  // eslint-disable-next-line no-control-regex
  const specials = /["\\\u0000-\u001f\ud800-\udfff]/g;
  const string = (text: string) => {
    add(2);
    // UTF-16 length is a lower bound for the UTF-8 JSON representation. Reject
    // obviously oversized input before even the native byte-count/regexp scans.
    if (text.length > RUNTIME_LIMITS.frameBytes - bytes)
      throw new Error('Runtime frame exceeds its byte limit');
    add(Buffer.byteLength(text));
    specials.lastIndex = 0;
    for (let match = specials.exec(text); match; match = specials.exec(text)) {
      const unit = text.charCodeAt(match.index);
      if (unit === 0x22 || unit === 0x5c) add(1);
      else if (unit < 0x20)
        add(unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13 ? 1 : 5);
      else {
        const next = text.charCodeAt(match.index + 1);
        if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) specials.lastIndex++;
        // byteLength counts lone surrogates as three replacement bytes; JSON
        // uses six ASCII escape bytes. Valid pairs already have their exact size.
        else add(3);
      }
    }
  };
  const unsupported = () => new Error('Runtime frame requires plain schema JSON');
  const checkToJson = (object: object) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, 'toJSON');
    if (descriptor && (!('value' in descriptor) || typeof descriptor.value === 'function'))
      throw unsupported();
  };
  const walk = (item: unknown, depth: number): void => {
    visit(depth);
    if (item === null) return add(4);
    switch (typeof item) {
      case 'string':
        return string(item);
      case 'boolean':
        return add(item ? 4 : 5);
      case 'number':
        return add(Number.isFinite(item) ? String(item).length : 4);
      case 'object':
        break;
      default:
        throw unsupported();
    }
    if (types.isProxy(item)) throw unsupported();
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
      throw unsupported();
    checkToJson(item);
    if (prototype !== null) checkToJson(prototype as object);
    if (array) checkToJson(Object.prototype);
    if (ancestors.has(item)) throw new Error('Runtime JSON contains a cycle');
    ancestors.add(item);
    add(2);
    if (array) {
      // Array indices are serialised even when non-enumerable; holes become null.
      for (let index = 0; index < item.length; index++) {
        if (index) add(1);
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor) {
          visit(depth + 1);
          if (index in item) throw unsupported();
          add(4);
        } else {
          if (!('value' in descriptor)) throw unsupported();
          if (descriptor.value === undefined || typeof descriptor.value === 'symbol') {
            visit(depth + 1);
            add(4);
          } else walk(descriptor.value, depth + 1);
        }
      }
    } else {
      let first = true;
      // Do not allocate an unbounded Object.keys/entries array before admission.
      for (const key in item) {
        visit();
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor) continue;
        if (!('value' in descriptor)) throw unsupported();
        if (descriptor.value === undefined || typeof descriptor.value === 'symbol') continue;
        if (!first) add(1);
        first = false;
        string(key);
        add(1);
        walk(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  walk(value, 0);
  return { bytes, values };
}
