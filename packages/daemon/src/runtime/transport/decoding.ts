import { RUNTIME_LIMITS } from '@puddle/shared';
import { RUNTIME_JSON_LIMITS } from './encoding.js';

// UTF-16 source/parsed strings and synchronous schema JSON/UTF-8 validation,
// plus parsed/schema object metadata. The incoming body and any retained
// request reserve their own overlapping charge. Charged units are not RSS.
const workingBytes = (bytes: number, values: number) => 6 * bytes + 256 * values + 1024;
export const RUNTIME_DECODE_BYTES = workingBytes(
  RUNTIME_LIMITS.frameBytes,
  RUNTIME_JSON_LIMITS.values,
);

/**
 * Bound structural expansion before UTF-8 decoding or JSON.parse. This only
 * counts token starts and nesting outside quoted strings; it does not validate
 * JSON syntax, interpret escapes, build a tree or replace the native parser.
 */
export function runtimeJsonDecodeBytes(body: Buffer): number {
  if (body.length > RUNTIME_LIMITS.frameBytes)
    throw new Error('Runtime frame exceeds its byte limit');
  let depth = 0;
  let values = 0;
  let quoted = false;
  let escaped = false;
  let primitive = false;
  const visit = () => {
    if (++values > RUNTIME_JSON_LIMITS.values)
      throw new Error('Runtime JSON traversal capacity exceeded');
    if (depth > RUNTIME_JSON_LIMITS.depth) throw new Error('Runtime JSON depth capacity exceeded');
  };
  for (const byte of body) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) quoted = false;
      continue;
    }
    if (byte === 34) {
      visit();
      quoted = true;
      primitive = false;
    } else if (byte === 123 || byte === 91) {
      visit();
      depth++;
      primitive = false;
    } else if (byte === 125 || byte === 93) {
      depth--;
      primitive = false;
    } else if (
      byte === 44 ||
      byte === 58 ||
      byte === 32 ||
      byte === 9 ||
      byte === 10 ||
      byte === 13
    ) {
      primitive = false;
    } else if (!primitive) {
      visit();
      primitive = true;
    }
  }
  return workingBytes(body.length, values);
}
