#!/usr/bin/env node
// Minimal bin entry; the full composition root (createDaemon) replaces this
// as Phase 1 lands its subsystems.
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { ensureHome, resolvePaths } from './paths.js';
import { ensureToken } from './security/token.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  version: string;
};

const paths = resolvePaths();
ensureHome(paths);
const config = loadConfig(paths);
const token = ensureToken(paths);
const app = buildApp({ version: pkg.version, assetsDir: join(here, 'public'), token });

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (info) => {
  console.log(`puddled ${pkg.version} listening on http://127.0.0.1:${info.port}`);
});
