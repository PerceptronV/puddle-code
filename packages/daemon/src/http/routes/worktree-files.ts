import {
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { ZipFile } from 'yazl';
import {
  putFileRequestSchema,
  type FileResponse,
  type PutFileResponse,
  type TreeEntry,
  type TreeResponse,
  type UploadResponse,
} from '@puddle/shared';
import type { SessionStore } from '../../db/stores/sessions.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../validate.js';
import { containedPath, resolveWorktree } from './worktree-shared.js';

/** Editor read cap: generous for source files, hostile to accidentally opening a media dump. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Multipart upload cap, checked against the raw `content-length` before parsing. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Binary sniffing looks for a NUL byte within this many leading bytes. */
const SNIFF_BYTES = 8 * 1024;

function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Content-types for the inline media viewer (SPEC §8) — image / video / audio /
 * pdf served for in-browser rendering rather than the octet-stream download.
 * Keyed by lower-case extension; anything unlisted falls back to
 * `application/octet-stream` at the route.
 */
const MEDIA_MIME: Record<string, string> = {
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  // documents
  pdf: 'application/pdf',
};

function mediaMime(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return MEDIA_MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** One tree entry for a directory child; `lstat` decides file/dir/symlink, never following the link. */
function describeEntry(dir: string, name: string): TreeEntry {
  const full = join(dir, name);
  const lst = lstatSync(full);
  if (lst.isSymbolicLink()) return { name, type: 'symlink', size: null };
  if (lst.isDirectory()) return { name, type: 'dir', size: null };
  return { name, type: 'file', size: statSync(full).size };
}

/** Recursively list zip-worthy files under `dir`, skipping `.git` and symlinks; `prefix` is the in-zip path so far. */
function collectZipEntries(dir: string, prefix: string): Array<{ abs: string; rel: string }> {
  const out: Array<{ abs: string; rel: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) continue;
    if (lst.isDirectory()) out.push(...collectZipEntries(abs, rel));
    else if (lst.isFile()) out.push({ abs, rel });
  }
  return out;
}

/**
 * Browse, read, write, upload to, and download from a session's worktree
 * (SPEC §6/§8, Phase 3 file explorer). Mounted by `worktrees.ts`.
 */
export function worktreeFileRoutes(deps: { sessions: SessionStore }): Hono {
  return new Hono()
    .get('/:sid/tree', (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const rel = c.req.query('path') ?? '';
      const dir = containedPath(root, rel);
      if (!existsSync(dir)) throw ApiError.notFound('path', rel || '.');
      if (!statSync(dir).isDirectory()) {
        throw ApiError.badRequest('not_a_directory', `${rel || '.'} is not a directory`);
      }
      const entries = readdirSync(dir)
        .filter((name) => name !== '.git')
        .map((name) => describeEntry(dir, name))
        .sort((a, b) => {
          if (a.type === 'dir' && b.type !== 'dir') return -1;
          if (a.type !== 'dir' && b.type === 'dir') return 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
      return c.json<TreeResponse>({ path: rel, entries });
    })

    .get('/:sid/file', (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const rel = c.req.query('path') ?? '';
      const target = containedPath(root, rel);
      if (!existsSync(target)) throw ApiError.notFound('file', rel);
      const st = statSync(target);
      if (!st.isFile()) throw ApiError.badRequest('not_a_file', `${rel} is not a file`);
      if (st.size > MAX_FILE_BYTES) {
        throw new ApiError(
          413,
          'file_too_large',
          `${rel} is ${st.size} bytes; the cap is ${MAX_FILE_BYTES}`,
        );
      }
      const buf = readFileSync(target);
      const binary = buf.subarray(0, SNIFF_BYTES).includes(0);
      return c.json<FileResponse>({
        path: rel,
        content: binary ? null : buf.toString('utf8'),
        binary,
        size: st.size,
        mtime_ms: st.mtimeMs,
      });
    })

    .put('/:sid/file', async (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const rel = c.req.query('path') ?? '';
      const target = containedPath(root, rel);
      const body = await parseBody(c, putFileRequestSchema);

      const parent = dirname(target);
      if (!existsSync(parent) || !statSync(parent).isDirectory()) {
        throw ApiError.badRequest('not_a_directory', `parent directory of ${rel} does not exist`);
      }
      if (body.expected_mtime_ms !== undefined) {
        if (!existsSync(target)) {
          throw ApiError.conflict('stale_file', `${rel} no longer exists`);
        }
        const current = statSync(target).mtimeMs;
        if (current !== body.expected_mtime_ms) {
          throw ApiError.conflict(
            'stale_file',
            `${rel} changed on disk since it was loaded (current mtime_ms ${current})`,
          );
        }
      }
      // Single daemon process for v1: the stat-then-write above is not atomic
      // with this write, so a write landing in that gap is accepted as a rare
      // race rather than engineered around with file locks.
      writeFileSync(target, body.content, 'utf8');
      const st = statSync(target);
      return c.json<PutFileResponse>({ path: rel, mtime_ms: st.mtimeMs, size: st.size });
    })

    .post('/:sid/upload', async (c) => {
      const contentLength = Number(c.req.header('content-length') ?? '0');
      if (contentLength > MAX_UPLOAD_BYTES) {
        throw new ApiError(
          413,
          'upload_too_large',
          `upload is ${contentLength} bytes; the cap is ${MAX_UPLOAD_BYTES}`,
        );
      }
      const { root } = resolveWorktree(deps.sessions, c);
      const rel = c.req.query('dir') ?? '';
      const dir = containedPath(root, rel);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw ApiError.badRequest('not_a_directory', `${rel || '.'} is not a directory`);
      }

      const form = await c.req.parseBody({ all: true });
      const files = Object.values(form)
        .flat()
        .filter((value): value is File => value instanceof File);
      if (files.length === 0) {
        throw ApiError.badRequest('nothing_uploaded', 'no files were present in the upload');
      }

      const uploaded: UploadResponse['files'] = [];
      for (const file of files) {
        // Basename first, then re-run through containedPath: a filename that
        // arrives as `../../evil.txt` is neutralised to `evil.txt` and lands
        // inside `dir`, mirroring an OS drag-and-drop copy rather than
        // rejecting the whole upload.
        const name = basename(file.name);
        const relPath = rel ? `${rel}/${name}` : name;
        const dest = containedPath(root, relPath);
        const bytes = Buffer.from(await file.arrayBuffer());
        writeFileSync(dest, bytes);
        uploaded.push({ path: relPath, size: bytes.byteLength });
      }
      return c.json<UploadResponse>({ files: uploaded }, 201);
    })

    .get('/:sid/media', (c) => {
      // Serve a file's raw bytes for INLINE rendering (image/video/audio/pdf) —
      // the real content-type + `inline` disposition, unlike `/download`'s
      // always-`attachment` octet-stream. The web viewer fetches this through
      // the authed API and hands the element an object URL (SPEC §8).
      const { root } = resolveWorktree(deps.sessions, c);
      const rel = c.req.query('path') ?? '';
      const target = containedPath(root, rel);
      if (!existsSync(target)) throw ApiError.notFound('path', rel);
      const st = statSync(target);
      if (!st.isFile()) throw ApiError.badRequest('not_a_file', `${rel} is not a file`);
      const name = basename(target);
      const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
      return new Response(stream, {
        headers: {
          'content-type': mediaMime(name) ?? 'application/octet-stream',
          'content-length': String(st.size),
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      });
    })

    .get('/:sid/download', (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const rel = c.req.query('path') ?? '';
      const target = containedPath(root, rel);
      if (!existsSync(target)) throw ApiError.notFound('path', rel);
      const st = statSync(target);
      const name = basename(target) || 'worktree';

      if (st.isFile()) {
        const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
        return new Response(stream, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(st.size),
            'content-disposition': contentDisposition(name),
          },
        });
      }

      // Directory: stream a zip built from every non-.git, non-symlink file.
      // Pure-JS (yazl) deliberately — no native deps in the prebuilt tarball.
      const zipfile = new ZipFile();
      for (const { abs, rel: zipRel } of collectZipEntries(target, '')) {
        zipfile.addFile(abs, zipRel);
      }
      zipfile.end();
      const stream = Readable.toWeb(zipfile.outputStream as Readable) as ReadableStream;
      return new Response(stream, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': contentDisposition(`${name}.zip`),
        },
      });
    });
}
