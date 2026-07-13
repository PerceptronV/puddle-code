// Embed the built web UI into the daemon package so one artefact serves both.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', '..', 'web', 'dist');
const target = join(here, '..', 'dist', 'public');

if (!existsSync(webDist)) {
  console.error('web assets not built — run `pnpm --filter @puddle/web build` first');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(webDist, target, { recursive: true });
console.log(`embedded web assets → ${target}`);
