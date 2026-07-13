import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { PuddlePaths } from '../paths.js';

/**
 * The browser-facing bearer token (SPEC §2 "Local security"). Generated once
 * at first start; the CLI reads this file (locally or over SSH) and hands it
 * to the browser as a URL fragment.
 */
export function ensureToken(paths: PuddlePaths): string {
  try {
    const existing = readFileSync(paths.tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // absent → generate below
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(paths.tokenFile, token + '\n', { mode: 0o600 });
  return token;
}
