import { RUNTIME_LIMITS } from '@puddle/shared';
import { RUNTIME_JSON_LIMITS } from './encoding.js';

// UTF-16 source/parsed strings and synchronous schema JSON/UTF-8 validation,
// plus parsed/schema object metadata. The incoming body and any retained
// request reserve their own overlapping charge. Charged units are not RSS.
export const JSON_VALUE_METADATA_BYTES = 256;
const workingBytes = (bytes: number, values: number) =>
  6 * bytes + JSON_VALUE_METADATA_BYTES * values + 1024;
export const RUNTIME_DECODE_BYTES = workingBytes(
  RUNTIME_LIMITS.frameBytes,
  RUNTIME_JSON_LIMITS.values,
);

/**
 * Bound structural expansion before UTF-8 decoding or JSON.parse. This only
 * counts token starts and nesting outside quoted strings; it does not validate
 * JSON syntax, interpret escapes, build a tree or replace the native parser.
 */
export function jsonStructuralValues(
  body: Buffer,
  limits: { bytes: number; values?: number; depth?: number },
): number {
  if (body.length > limits.bytes) throw new Error('JSON body exceeds its byte limit');
  let depth = 0;
  let values = 0;
  let quoted = false;
  let escaped = false;
  let primitive = false;
  const visit = () => {
    if (++values > (limits.values ?? Number.MAX_SAFE_INTEGER))
      throw new Error('Runtime JSON traversal capacity exceeded');
    if (depth > (limits.depth ?? Number.MAX_SAFE_INTEGER))
      throw new Error('Runtime JSON depth capacity exceeded');
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
  return values;
}

export function runtimeJsonDecodeBytes(body: Buffer): number {
  if (body.length > RUNTIME_LIMITS.frameBytes)
    throw new Error('Runtime frame exceeds its byte limit');
  return workingBytes(
    body.length,
    jsonStructuralValues(body, {
      bytes: RUNTIME_LIMITS.frameBytes,
      values: RUNTIME_JSON_LIMITS.values,
      depth: RUNTIME_JSON_LIMITS.depth,
    }),
  );
}
