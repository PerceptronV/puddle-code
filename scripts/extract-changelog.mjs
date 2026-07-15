#!/usr/bin/env node
/**
 * Prints the release notes for a version to stdout, for the release workflow's
 * `gh release create --notes-file`. The source is the durable per-version
 * archive `docs/changelogs/CHANGELOG-v<version>.md` (the rolling root
 * CHANGELOG.md is reset to an empty template on publish, so it carries nothing
 * at the tagged commit — CLAUDE.md §"Changelog discipline").
 *
 * Usage: node scripts/extract-changelog.mjs <version>   # e.g. 0.0.2
 * Strips the leading HTML-comment template header, the `# Changelog` title,
 * and the `## [x.y.z] — date` heading, leaving just the `### Added/…` body.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/extract-changelog.mjs <version>');
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(repoRoot, 'docs/changelogs', `CHANGELOG-v${version}.md`);

let raw;
try {
  raw = readFileSync(path, 'utf8');
} catch {
  console.error(`extract-changelog: ${path} not found`);
  process.exit(1);
}

const notes = raw
  .replace(/^<!--[\s\S]*?-->\s*/, '') // template header comment
  .replace(/^#\s+Changelog\s*/m, '') // the `# Changelog` title
  .replace(/^##\s+\[.*?\].*$/m, '') // the `## [x.y.z] — date` heading
  .trim();

if (!notes) {
  console.error(`extract-changelog: ${path} has no notes body`);
  process.exit(1);
}

process.stdout.write(notes + '\n');
