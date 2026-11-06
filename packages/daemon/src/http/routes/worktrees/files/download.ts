import { createReadStream, type Dir, type ReadStream } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { admitFileTransfer } from './admission.js';

const BUFFER_BYTES = 64 * 1024;
// yazl retains central-directory records until completion. Bound that retained
// metadata separately from file-content backpressure; never return a partial ZIP.
const MAX_FILES = 10_000;
const MAX_PATH_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 128;

export function webFileStream(stream: Readable): ReadableStream<Uint8Array> {
  // Node's default toWeb strategy counts chunks, not bytes.
  return Readable.toWeb(stream, {
    strategy: { highWaterMark: BUFFER_BYTES, size: (chunk: Uint8Array) => chunk.byteLength },
  }) as ReadableStream<Uint8Array>;
}

export function directoryZip(root: string, requestSignal: AbortSignal): ReadableStream<Uint8Array> {
  const release = admitFileTransfer();
  const zip = new ZipFile();
  const output = zip.outputStream as PassThrough;
  const controller = new AbortController();
  const signal = controller.signal;
  let current: ReadStream | undefined;
  const cancel = () => {
    controller.abort();
    current?.destroy();
    output.destroy();
  };
  requestSignal.addEventListener('abort', cancel, { once: true });
  output.once('close', cancel);
  // Stream errors after response headers must fail the download, not crash the daemon.
  zip.on('error', (error: Error) => output.destroy(error));
  output.on('error', () => controller.abort());
  const produce = async () => {
    const directories: Array<{ dir: Dir; prefix: string }> = [];
    try {
      if (requestSignal.aborted) cancel();
      signal.throwIfAborted();
      directories.push({ dir: await opendir(root), prefix: '' });
      let files = 0,
        pathBytes = 0;
      while (directories.length) {
        signal.throwIfAborted();
        const parent = directories.at(-1)!;
        const entry = await parent.dir.read();
        if (!entry) {
          await parent.dir.close();
          directories.pop();
          continue;
        }
        if (entry.name === '.git' || entry.isSymbolicLink()) continue;
        const path = join(parent.dir.path, entry.name);
        const name = parent.prefix ? `${parent.prefix}/${entry.name}` : entry.name;
        const metadata = await lstat(path);
        signal.throwIfAborted();
        if (metadata.isDirectory()) {
          if (directories.length >= MAX_DEPTH)
            throw new Error('ZIP directory depth limit exceeded');
          directories.push({ dir: await opendir(path), prefix: name });
        } else if (metadata.isFile()) {
          pathBytes += Buffer.byteLength(name);
          if (++files > MAX_FILES || pathBytes > MAX_PATH_BYTES)
            throw new Error('ZIP metadata limit exceeded; download smaller directories');
          // One active input and at most one successor. Traversal waits for
          // content consumption, so a slow client also slows metadata discovery.
          await new Promise<void>((resolve, reject) => {
            const aborted = () => reject(signal.reason);
            signal.addEventListener('abort', aborted, { once: true });
            zip.addReadStreamLazy(
              name,
              { size: metadata.size, mtime: metadata.mtime, mode: metadata.mode },
              (callback) => {
                if (signal.aborted) {
                  signal.removeEventListener('abort', aborted);
                  reject(signal.reason);
                  return;
                }
                current = createReadStream(path, { highWaterMark: BUFFER_BYTES });
                current.once('error', (error) => {
                  output.destroy(error);
                  reject(error);
                });
                current.once('end', resolve);
                current.once('close', () => signal.removeEventListener('abort', aborted));
                callback(null, current);
              },
            );
          });
          if (output.writableNeedDrain) await once(output, 'drain', { signal });
        }
      }
      zip.end();
      await once(output, 'end', { signal });
    } catch (error) {
      current?.destroy();
      if (!output.destroyed)
        output.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await Promise.allSettled(directories.map(({ dir }) => dir.close()));
      requestSignal.removeEventListener('abort', cancel);
      release();
    }
  };
  void produce();
  return webFileStream(output);
}
