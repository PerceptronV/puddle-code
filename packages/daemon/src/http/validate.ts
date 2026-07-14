import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError } from './errors.js';

/** Parse and validate a JSON body against a shared schema; 400 on failure. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown = {};
  try {
    raw = await c.req.json();
  } catch {
    // Empty or non-JSON body → validate {} so optional-only schemas pass.
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ');
    throw ApiError.badRequest('invalid_request', detail);
  }
  return result.data;
}

/** Positive-integer path param; 400 otherwise. */
export function idParam(c: Context, name = 'id'): number {
  const value = Number(c.req.param(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw ApiError.badRequest('invalid_id', `path parameter '${name}' must be a positive integer`);
  }
  return value;
}

/** Project ids are 10 hex chars; 400 otherwise. */
export function projectIdParam(c: Context, name = 'id'): string {
  const value = c.req.param(name) ?? '';
  if (!/^[0-9a-f]{10}$/.test(value)) {
    throw ApiError.badRequest('invalid_id', `path parameter '${name}' must be a 10-hex project id`);
  }
  return value;
}
