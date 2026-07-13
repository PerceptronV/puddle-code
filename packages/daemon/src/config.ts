import { readFileSync, writeFileSync } from 'node:fs';
import {
  daemonConfigPatchSchema,
  daemonConfigSchema,
  type DaemonConfig,
  type DaemonConfigPatch,
} from '@puddle/shared';
import type { PuddlePaths } from './paths.js';

function read(paths: PuddlePaths): DaemonConfig {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  } catch {
    // Absent or unreadable → defaults; loadConfig persists them below.
  }
  return daemonConfigSchema.parse(raw);
}

/** Load config.json, filling defaults; writes the file so users can discover the knobs. */
export function loadConfig(paths: PuddlePaths): DaemonConfig {
  const cfg = read(paths);
  writeFileSync(paths.configFile, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

export function saveConfig(paths: PuddlePaths, patch: DaemonConfigPatch): DaemonConfig {
  const merged = daemonConfigSchema.parse({
    ...read(paths),
    ...daemonConfigPatchSchema.parse(patch),
  });
  writeFileSync(paths.configFile, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}
