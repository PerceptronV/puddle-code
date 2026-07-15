import { readFileSync, writeFileSync } from 'node:fs';
import {
  daemonConfigPatchSchema,
  daemonConfigSchema,
  type DaemonConfig,
  type DaemonConfigPatch,
} from '@puddle/shared';
import type { PuddlePaths } from './paths.js';

/**
 * The file-only format marker. loadConfig has always written defaults back, so
 * every pre-Phase-6 config.json literally says "port": 7433 — indistinguishable
 * from a user choice. Version 2 (the daemon moved to 7434 when the CLI took
 * over UI serving) migrates that one value once; the marker's presence stops
 * the migration re-firing, so a deliberate post-migration 7433 is respected.
 * zod strips the marker on parse — it never reaches the API.
 */
const CONFIG_VERSION = 2;

function read(paths: PuddlePaths): DaemonConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>;
  } catch {
    // Absent or unreadable → defaults; loadConfig persists them below.
  }
  if (raw.configVersion === undefined && raw.port === 7433) {
    delete raw.port; // falls through to the version-2 default (7434)
  }
  return daemonConfigSchema.parse(raw);
}

function write(paths: PuddlePaths, cfg: DaemonConfig): void {
  writeFileSync(
    paths.configFile,
    JSON.stringify({ ...cfg, configVersion: CONFIG_VERSION }, null, 2) + '\n',
  );
}

/** Load config.json, filling defaults; writes the file so users can discover the knobs. */
export function loadConfig(paths: PuddlePaths): DaemonConfig {
  const cfg = read(paths);
  write(paths, cfg);
  return cfg;
}

export function saveConfig(paths: PuddlePaths, patch: DaemonConfigPatch): DaemonConfig {
  const merged = daemonConfigSchema.parse({
    ...read(paths),
    ...daemonConfigPatchSchema.parse(patch),
  });
  write(paths, merged);
  return merged;
}
