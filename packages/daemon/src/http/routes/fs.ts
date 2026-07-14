import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { Hono } from 'hono';
import type { FsDirsResponse } from '@puddle/shared';
import { ApiError } from '../errors.js';

const MAX_ENTRIES = 50;

/**
 * Directory autocomplete for repo registration (SPEC §6). Trusted single-user
 * box: the token holder can already spawn agents, so listing directories
 * grants nothing new. Directories only; dotdirs included.
 */
export function fsRoutes(): Hono {
  return new Hono().get('/dirs', (c) => {
    const prefix = c.req.query('prefix') ?? '';
    if (!isAbsolute(prefix)) {
      throw ApiError.badRequest('invalid_prefix', `'prefix' must be an absolute path`);
    }
    // "/a/b/par" completes "par" inside /a/b; a trailing slash lists everything.
    const parent = prefix.endsWith('/') ? prefix : dirname(prefix);
    const partial = prefix.endsWith('/') ? '' : basename(prefix).toLowerCase();

    let names: string[];
    try {
      names = readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name);
    } catch {
      return c.json<FsDirsResponse>({ entries: [] }); // unreadable parent → no hints
    }

    const entries = names
      .filter((name) => name.toLowerCase().startsWith(partial))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_ENTRIES)
      .map((name) => {
        const path = join(parent, name);
        return { path, name, is_git: existsSync(join(path, '.git')) };
      });
    return c.json<FsDirsResponse>({ entries });
  });
}
