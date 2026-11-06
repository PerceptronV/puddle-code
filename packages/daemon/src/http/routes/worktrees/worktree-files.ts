import { mediaMime } from './media-mime.js';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { directoryEntries } from './files/tree.js';
import { directoryZip, webFileStream } from './files/download.js';
import { MAX_UPLOAD_BYTES, uploadFiles, uploadTooLarge } from './files/upload.js';
import { Hono } from 'hono';
import { newFileContent } from '../../../notebooks/empty.js';
import {
  putFileRequestSchema,
  type FileResponse,
  type PutFileResponse,
  type TreeResponse,
  type UploadResponse,
} from '@puddle/shared';
import { ApiError } from '../../errors.js';
import { parseBody } from '../../validate.js';
import {
  browseRoot,
  containedPath,
  resolveWorktree,
  type WorktreeDeps,
} from './worktree-shared.js';

/** Editor read cap: generous for source files, hostile to accidentally opening a media dump. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Binary sniffing looks for a NUL byte within this many leading bytes. */
const SNIFF_BYTES = 8 * 1024;

function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Browse, read, write, upload to, and download from a session's worktree
 * (SPEC §6/§8, Phase 3 file explorer). Mounted by `worktrees.ts`.
 */
export function worktreeFileRoutes(deps: WorktreeDeps): Hono {
  return new Hono()
    .get('/:sid/tree', async (c) => {
      // `?root=` (protocol 10.2): browse outside the worktree, read-only.
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const rel = c.req.query('path') ?? '';
      const dir = containedPath(root, rel);
      const metadata = await stat(dir).catch(() => null);
      if (!metadata) throw ApiError.notFound('path', rel || '.');
      if (!metadata.isDirectory())
        throw ApiError.badRequest('not_a_directory', `${rel || '.'} is not a directory`);
      const entries = await directoryEntries(dir, c.req.raw.signal);
      return c.json<TreeResponse>({ path: rel, entries });
    })

    .get('/:sid/file', (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
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
      // The file PUT accepts the browse override (10.4): an `external` tab is
      // a full editor, so its save must route to the same absolute file its
      // GET read. The fs mutation routes take it too, since 12.3.
      const root = browseRoot(c, resolveWorktree(deps, c).root);
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
      writeFileSync(
        target,
        existsSync(target) ? body.content : newFileContent(target, body.content),
        'utf8',
      );
      const st = statSync(target);
      return c.json<PutFileResponse>({ path: rel, mtime_ms: st.mtimeMs, size: st.size });
    })

    .post('/:sid/upload', async (c) => {
      const contentLength = Number(c.req.header('content-length') ?? '0');
      if (contentLength > MAX_UPLOAD_BYTES) throw uploadTooLarge();
      // `?root=` (12.3): a drop into the browse tree lands under that root, not
      // the worktree — the browse tree is the worktree tree, moved elsewhere.
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const rel = c.req.query('dir') ?? '';
      const dir = containedPath(root, rel);
      if (!(await stat(dir).catch(() => null))?.isDirectory()) {
        throw ApiError.badRequest('not_a_directory', `${rel || '.'} is not a directory`);
      }
      return c.json<UploadResponse>(await uploadFiles(c.req.raw, root, rel), 201);
    })

    .get('/:sid/media', (c) => {
      // Serve a file's raw bytes for INLINE rendering (image/video/audio/pdf) —
      // the real content-type + `inline` disposition, unlike `/download`'s
      // always-`attachment` octet-stream. The web viewer fetches this through
      // the authed API and hands the element an object URL (SPEC §8).
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const rel = c.req.query('path') ?? '';
      const target = containedPath(root, rel);
      if (!existsSync(target)) throw ApiError.notFound('path', rel);
      const st = statSync(target);
      if (!st.isFile()) throw ApiError.badRequest('not_a_file', `${rel} is not a file`);
      const name = basename(target);
      const stream = webFileStream(createReadStream(target));
      return new Response(stream, {
        headers: {
          'content-type': mediaMime(name) ?? 'application/octet-stream',
          'content-length': String(st.size),
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      });
    })

    .get('/:sid/download', async (c) => {
      const root = browseRoot(c, resolveWorktree(deps, c).root);
      const rel = c.req.query('path') ?? '';
      const target = containedPath(root, rel);
      const st = await stat(target).catch(() => null);
      if (!st) throw ApiError.notFound('path', rel);
      const name = basename(target) || 'worktree';

      if (st.isFile()) {
        const stream = webFileStream(createReadStream(target));
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
      const stream = directoryZip(target, c.req.raw.signal);
      return new Response(stream, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': contentDisposition(`${name}.zip`),
        },
      });
    });
}
