import busboy from 'busboy';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UploadResponse } from '@puddle/shared';
import { ApiError } from '../../../errors.js';
import { containedPath } from '../worktree-shared.js';
import { admitFileTransfer } from './admission.js';

export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_PATH_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
export function uploadTooLarge(maxBytes = MAX_UPLOAD_BYTES): ApiError {
  return new ApiError(
    413,
    'upload_too_large',
    `The upload exceeds the ${maxBytes / (1024 * 1024)} MB per-request cap`,
  );
}

/** Stage bounded streams privately; malformed/cancelled bodies never touch destinations. */
export async function uploadFiles(
  request: Request,
  root: string,
  rel: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<UploadResponse> {
  if (Number(request.headers.get('content-length')) > maxBytes) throw uploadTooLarge(maxBytes);
  const release = admitFileTransfer();
  let scratch: string | undefined;
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  let input: Readable | undefined;
  let parser: ReturnType<typeof busboy> | undefined;
  // Serial writes bound open descriptors. Each input chunk waits for all parts
  // except the last (which may need another chunk to finish).
  let writes = Promise.resolve();
  let priorWrites = writes;
  let failure: unknown;
  const fail = (error: unknown) => {
    failure ??= error;
    abort.abort(error);
    parser?.destroy(error instanceof Error ? error : new Error(String(error)));
  };
  try {
    signal.throwIfAborted();
    if (!request.body)
      throw ApiError.badRequest('nothing_uploaded', 'no files were present in the upload');
    try {
      parser = busboy({
        headers: { 'content-type': request.headers.get('content-type') ?? '' },
        preservePath: true,
        defParamCharset: 'utf8',
        highWaterMark: CHUNK_BYTES,
        fileHwm: CHUNK_BYTES,
        limits: { files: MAX_FILES, fields: 0 },
      });
    } catch {
      throw ApiError.badRequest('invalid_upload', 'Expected a multipart form with a boundary');
    }
    parser.on('error', fail);
    parser.on('filesLimit', () =>
      fail(
        new ApiError(
          413,
          'upload_too_many_files',
          `An upload may contain at most ${MAX_FILES} files`,
        ),
      ),
    );
    scratch = await mkdtemp(join(tmpdir(), 'puddle-upload-'));
    const files: Array<{ path: string; dest: string; staged: string; size: number }> = [];
    let pathBytes = 0;
    parser.on('file', (_field, file, info) => {
      file.on('error', fail);
      const name = info.filename
        .split('/')
        .filter((part) => part !== '' && part !== '.' && part !== '..')
        .join('/');
      if (!name) {
        file.resume();
        return;
      }
      pathBytes += Buffer.byteLength(name);
      if (pathBytes > MAX_PATH_BYTES) {
        fail(
          new ApiError(
            413,
            'upload_too_many_files',
            'Upload paths exceed the metadata budget; use smaller batches',
          ),
        );
        file.resume();
        return;
      }
      const path = rel ? `${rel}/${name}` : name;
      const entry = {
        path,
        dest: containedPath(root, path),
        staged: join(scratch!, String(files.length)),
        size: 0,
      };
      files.push(entry);
      priorWrites = writes;
      writes = writes.then(async () => {
        signal.throwIfAborted();
        await pipeline(
          file,
          createWriteStream(entry.staged, { flags: 'wx', mode: 0o600, highWaterMark: CHUNK_BYTES }),
          { signal },
        );
        entry.size = (await stat(entry.staged)).size;
      });
      void writes.catch(fail);
    });
    input = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream, {
      signal,
      highWaterMark: CHUNK_BYTES,
    });
    let bytes = 0;
    for await (const value of input) {
      const chunk = value as Buffer;
      bytes += chunk.length;
      if (bytes > maxBytes) throw uploadTooLarge(maxBytes);
      for (let start = 0; start < chunk.length; start += CHUNK_BYTES) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) =>
          parser!.write(chunk.subarray(start, start + CHUNK_BYTES), (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        await priorWrites;
      }
    }
    await new Promise<void>((resolve, reject) => {
      parser!.once('error', reject);
      parser!.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    await writes;
    if (!files.length)
      throw ApiError.badRequest('nothing_uploaded', 'no files were present in the upload');
    for (const entry of files) {
      signal.throwIfAborted();
      await mkdir(dirname(entry.dest), { recursive: true });
      signal.throwIfAborted();
      // Finish each accepted file before observing cancellation between files.
      // Opening with w preserves existing symlinks, hard links and file mode;
      // a rename or copyFile would change those overwrite semantics.
      await pipeline(createReadStream(entry.staged), createWriteStream(entry.dest));
    }
    return { files: files.map(({ path, size }) => ({ path, size })) };
  } catch (error) {
    fail(error);
    throw failure;
  } finally {
    input?.destroy();
    parser?.destroy();
    await writes.catch(() => undefined);
    try {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}
