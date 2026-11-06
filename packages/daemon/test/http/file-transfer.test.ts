import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  link,
  chmod,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReadStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as yauzl from 'yauzl';

const probes = vi.hoisted(() => ({
  stats: 0,
  inflight: 0,
  maxInflight: 0,
  slow: false,
  slowWrites: false,
  failReads: false,
  reads: new Set<ReadStream>(),
  stages: [] as string[],
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      probes.stats++;
      probes.inflight++;
      probes.maxInflight = Math.max(probes.maxInflight, probes.inflight);
      try {
        if (probes.slow) await new Promise((r) => setTimeout(r, 2));
        return await fs.lstat(...args);
      } finally {
        probes.inflight--;
      }
    },
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      const path = await fs.mkdtemp(...args);
      if (String(path).includes('puddle-upload-')) probes.stages.push(String(path));
      return path;
    },
  };
});
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
      const stream = fs.createWriteStream(...args);
      if (probes.slowWrites) {
        const write = stream._write;
        stream._write = (chunk, encoding, callback) => {
          setTimeout(() => write.call(stream, chunk, encoding, callback), 4);
        };
      }
      return stream;
    },
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      const stream = probes.failReads
        ? fs.createReadStream(join(String(args[0]), 'missing'))
        : fs.createReadStream(...args);
      probes.reads.add(stream);
      stream.once('close', () => probes.reads.delete(stream));
      return stream;
    },
  };
});
import { uploadFiles } from '../../src/http/routes/worktrees/files/upload.js';
import { directoryZip } from '../../src/http/routes/worktrees/files/download.js';
import { directoryEntries } from '../../src/http/routes/worktrees/files/tree.js';

const roots: string[] = [];
const root = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'puddle-transfer-test-'));
  roots.push(dir);
  return dir;
};
afterEach(async () => {
  await vi.waitFor(() => expect(probes.reads.size).toBe(0));
  for (const stage of probes.stages.splice(0))
    await expect(stat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
  probes.stats = probes.inflight = probes.maxInflight = 0;
  probes.slow = probes.slowWrites = probes.failReads = false;
});
function request(
  body: ReadableStream<Uint8Array>,
  boundary = 'boundary',
  signal?: AbortSignal,
  length?: string,
) {
  return new Request('http://localhost/upload', {
    method: 'POST',
    body,
    duplex: 'half',
    signal,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      ...(length ? { 'content-length': length } : {}),
    },
  } as RequestInit);
}
function part(name: string) {
  return Buffer.from(
    `--boundary\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
}
const end = Buffer.from('\r\n--boundary--\r\n');
function chunks(values: Uint8Array[], onCancel?: () => void) {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (index < values.length) c.enqueue(values[index++]!);
        else c.close();
      },
      cancel() {
        onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );
}
async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const values = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(values));
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error);
          const data: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => data.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            values.set(entry.fileName, Buffer.concat(data));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    }),
  );
}

describe('bounded asynchronous file transfer', () => {
  it('streams a large upload, yields, and preserves UTF-8 filenames, duplicate overwrite order, symlinks, hard links and modes', async () => {
    const dir = await root();
    await writeFile(join(dir, 'existing'), 'old');
    await chmod(join(dir, 'existing'), 0o755);
    await symlink('existing', join(dir, 'link'));
    await link(join(dir, 'existing'), join(dir, 'hard'));
    const payload = Buffer.alloc(64 * 1024, 42);
    const values = [
      part('nested/写真.bin'),
      ...Array.from({ length: 256 }, () => payload),
      Buffer.from('\r\n'),
      part('link'),
      Buffer.from('first\r\n'),
      part('link'),
      Buffer.from('last'),
      end,
    ];
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const result = await uploadFiles(request(chunks(values)), dir, '');
      expect(result.files).toEqual([
        { path: 'nested/写真.bin', size: 16 * 1024 * 1024 },
        { path: 'link', size: 5 },
        { path: 'link', size: 4 },
      ]);
      expect(ticks).toBeGreaterThan(0);
      expect(await stat(join(dir, 'nested/写真.bin'))).toMatchObject({ size: 16 * 1024 * 1024 });
      expect(await readFile(join(dir, 'existing'), 'utf8')).toBe('last');
      expect(await readFile(join(dir, 'hard'), 'utf8')).toBe('last');
      expect((await stat(join(dir, 'existing'))).mode & 0o777).toBe(0o755);
    } finally {
      clearInterval(timer);
    }
  });

  it.each([undefined, '1'])(
    'counts actual request bytes with content-length %s and cancels excess input',
    async (length) => {
      const dir = await root();
      await writeFile(join(dir, 'keep'), 'old');
      let cancelled = false;
      const values = [
        part('keep'),
        ...Array.from({ length: 32 }, () => Buffer.alloc(64 * 1024)),
        end,
      ];
      await expect(
        uploadFiles(
          request(
            chunks(values, () => (cancelled = true)),
            'boundary',
            undefined,
            length,
          ),
          dir,
          '',
          1024 * 1024,
        ),
      ).rejects.toMatchObject({ code: 'upload_too_large', status: 413 });
      expect(cancelled).toBe(true);
      expect(await readFile(join(dir, 'keep'), 'utf8')).toBe('old');
    },
  );

  it('does not commit any part of malformed or cancelled requests', async () => {
    const dir = await root();
    await writeFile(join(dir, 'keep'), 'old');
    await expect(
      uploadFiles(request(chunks([part('keep'), Buffer.from('unfinished')])), dir, ''),
    ).rejects.toThrow();
    expect(await readFile(join(dir, 'keep'), 'utf8')).toBe('old');
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(part('keep'));
        c.enqueue(Buffer.alloc(128 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = uploadFiles(request(body, 'boundary', controller.signal), dir, '');
    const observed = expect(pending).rejects.toThrow();
    await delay(10);
    controller.abort();
    await observed;
    expect(cancelled).toBe(true);
    expect(await readFile(join(dir, 'keep'), 'utf8')).toBe('old');
  });

  it('handles destination failures without leaking staging files or transfer admission', async () => {
    const dir = await root();
    await mkdir(join(dir, 'is-dir'));
    for (let i = 0; i < 5; i++)
      await expect(
        uploadFiles(request(chunks([part('is-dir'), Buffer.from('bad'), end])), dir, ''),
      ).rejects.toMatchObject({ code: 'EISDIR' });
    expect(await readdir(dir)).toEqual(['is-dir']);
  });

  it('drains many tiny multipart files without accumulating open streams', async () => {
    const dir = await root();
    const body: Buffer[] = [];
    for (let i = 0; i < 200; i++) body.push(part(`${i}.txt`), Buffer.from('x\r\n'));
    body.push(Buffer.from('--boundary--\r\n'));
    expect((await uploadFiles(request(chunks([Buffer.concat(body)])), dir, '')).files).toHaveLength(
      200,
    );
    expect(await readdir(dir)).toHaveLength(200);
  });

  it('propagates slow-disk backpressure to the upload producer', async () => {
    const dir = await root();
    probes.slowWrites = true;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          if (pulls === 1) c.enqueue(part('large'));
          else if (pulls <= 65) c.enqueue(Buffer.alloc(64 * 1024));
          else if (pulls === 66) c.enqueue(end);
          else c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const pending = uploadFiles(request(body), dir, '');
    await delay(20);
    expect(pulls).toBeLessThan(30);
    expect((await pending).files[0]?.size).toBe(4 * 1024 * 1024);
  });

  it('fails ZIP reads cleanly and releases admission after filesystem errors', async () => {
    const dir = await root();
    await writeFile(join(dir, 'file'), 'x');
    probes.failReads = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        new Response(directoryZip(dir, new AbortController().signal)).arrayBuffer(),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(probes.reads.size).toBe(0));
    }
    probes.failReads = false;
    expect(
      (
        await unzip(
          Buffer.from(
            await new Response(directoryZip(dir, new AbortController().signal)).arrayBuffer(),
          ),
        )
      )
        .get('file')
        ?.toString(),
    ).toBe('x');
  });

  it('enumerates trees asynchronously with one metadata operation at a time and supports cancellation', async () => {
    const dir = await root();
    for (let i = 0; i < 80; i++) await writeFile(join(dir, `${i}.txt`), 'x');
    await mkdir(join(dir, '.git'));
    await mkdir(join(dir, 'sub'));
    await symlink('sub', join(dir, 'linked'));
    await symlink('missing', join(dir, 'broken'));
    probes.slow = true;
    const values = await directoryEntries(dir, new AbortController().signal);
    expect(values).toHaveLength(83);
    expect(probes.stats).toBe(83);
    expect(probes.maxInflight).toBe(1);
    expect(values[0]?.type).toBe('dir');
    expect(values.find((e) => e.name === 'broken')).toMatchObject({
      type: 'symlink',
      symlink: true,
    });
    const controller = new AbortController();
    const pending = directoryEntries(dir, controller.signal);
    const observed = expect(pending).rejects.toThrow();
    await delay(5);
    controller.abort();
    await observed;
  });

  it('streams ZIP entries with exact content, skipping nested .git and symlinks', async () => {
    const dir = await root();
    await mkdir(join(dir, 'nested'));
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, 'nested', 'one'), 'hello');
    await writeFile(join(dir, 'zero'), '');
    await writeFile(join(dir, '.git', 'skip'), 'hidden');
    await symlink('nested', join(dir, 'linked'));
    await symlink('/missing', join(dir, 'broken'));
    const response = new Response(directoryZip(dir, new AbortController().signal));
    expect(await unzip(Buffer.from(await response.arrayBuffer()))).toEqual(
      new Map([
        ['nested/one', Buffer.from('hello')],
        ['zero', Buffer.alloc(0)],
      ]),
    );
  });

  it('bounds discovery for slow consumers and releases reads/admission on response cancellation', async () => {
    const dir = await root();
    // Incompressible data ensures output backpressure before traversal can run ahead.
    const { randomBytes } = await import('node:crypto');
    const bytes = randomBytes(512 * 1024);
    for (let i = 0; i < 20; i++) await writeFile(join(dir, `${i}.bin`), bytes);
    for (let attempt = 0; attempt < 5; attempt++) {
      probes.stats = 0;
      const stream = directoryZip(dir, new AbortController().signal);
      await delay(20);
      expect(probes.stats).toBeLessThan(5);
      await stream.cancel();
      await vi.waitFor(() => expect(probes.reads.size).toBe(0));
    }
  });

  it('rejects excess concurrent downloads and admits another after cancellation', async () => {
    const dir = await root();
    await writeFile(join(dir, 'big'), (await import('node:crypto')).randomBytes(1024 * 1024));
    const streams = Array.from({ length: 4 }, () =>
      directoryZip(dir, new AbortController().signal),
    );
    expect(() => directoryZip(dir, new AbortController().signal)).toThrow(
      'Too many active file transfers',
    );
    await Promise.all(streams.map((s) => s.cancel()));
    await vi.waitFor(() => expect(probes.reads.size).toBe(0));
    await delay(10);
    await directoryZip(dir, new AbortController().signal).cancel();
  });
});
