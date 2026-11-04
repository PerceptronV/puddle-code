import type { IncomingMessage } from 'node:http';

export const RUNTIME_SIGNAL_BODY_BYTES = 2 * 1024 * 1024;
// One input buffer, UTF-8 text, parsed strings and schema/working copies.
export const RUNTIME_SIGNAL_WORK_BYTES = 6 * RUNTIME_SIGNAL_BODY_BYTES;
export const RUNTIME_SIGNAL_REQUESTS = 16;
export class RuntimeSignalBodyTooLarge extends Error {}

/** Signal schemas contain only one small, flat object; bound parsing work before JSON.parse. */
export function parseSignalBody(text: string): unknown {
  let quoted = false;
  let escaped = false;
  let objects = 0;
  let fields = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || (char === '{' && ++objects > 1) || (char === ':' && ++fields > 32))
      throw new Error('Runtime signal structure exceeds its limit');
  }
  return JSON.parse(text) as unknown;
}

/** Called only after the entire bounded body/parse allowance has been admitted. */
export async function readSignalBody(request: IncomingMessage): Promise<unknown> {
  const buffer = Buffer.allocUnsafe(RUNTIME_SIGNAL_BODY_BYTES);
  let bytes = 0;
  // Preserve the HTTP socket long enough to return an explicit 413 on overflow.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    if (data.length > buffer.length - bytes)
      throw new RuntimeSignalBodyTooLarge('Runtime signal body exceeds its limit');
    data.copy(buffer, bytes);
    bytes += data.length;
  }
  return parseSignalBody(buffer.toString('utf8', 0, bytes));
}
