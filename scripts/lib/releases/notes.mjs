import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 256 * 1024;

/** One exact release's source, shared by the cockpit and host distribution. */
export function releaseNotes(repo, version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error('Invalid release-notes version');
  let source;
  let heading = version;
  try {
    source = readFileSync(join(repo, 'docs/changelogs', `CHANGELOG-v${version}.md`), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const current = JSON.parse(readFileSync(join(repo, 'packages/daemon/package.json'), 'utf8'));
    if (current.version !== version) return null;
    source = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8');
    heading = 'Unreleased';
  }
  const lines = source.split('\n');
  const first = lines.findIndex((line) => line.startsWith(`## [${heading}]`));
  if (first < 0) throw new Error('Release notes have no matching version heading');
  const end = lines.findIndex((line, index) => index > first && line.startsWith('## '));
  const markdown =
    lines
      .slice(first, end < 0 ? undefined : end)
      .join('\n')
      .trim() + '\n';
  if (Buffer.byteLength(markdown) > MAX_BYTES) throw new Error('Release notes exceed 256 KiB');
  return markdown;
}
