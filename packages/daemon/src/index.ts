#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './daemon.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  version: string;
};

const daemon = await startDaemon({
  version: pkg.version,
  assetsDir: join(here, 'public'),
});
console.log(`puddled ${pkg.version} listening on http://127.0.0.1:${daemon.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received — shutting down (sessions become interrupted)`);
    void daemon.stop().then(() => process.exit(0));
  });
}
