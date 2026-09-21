import type { IncomingMessage, ServerResponse } from 'node:http';

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
export function fail(res: ServerResponse, status: number, code: string, message = code): void {
  json(res, status, { error: { code, message } });
}
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 16_384) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}
export function exactOrigin(req: IncomingMessage, origin: string, required = false): boolean {
  const url = new URL(origin);
  if (req.headers.host !== url.host) return false;
  if (req.headers.origin !== undefined) return req.headers.origin === origin;
  return !required;
}
