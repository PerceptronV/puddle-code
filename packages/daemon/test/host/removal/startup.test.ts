import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startDaemon } from '../../../src/daemon.js';

it.each(['services.json', 'purge.json'])(
  'refuses direct daemon startup before authority creation or database access with active %s',
  async (name) => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-removal-startup-'));
    const directory = join(home, 'installation/removal');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, name), '{', { mode: 0o600 });
    const database = join(home, 'puddle.db');
    writeFileSync(database, 'untouched database', { mode: 0o600 });
    try {
      await expect(startDaemon({ home, port: 0, adapters: [], runtime: false })).rejects.toThrow(
        /recorded host removal/,
      );
      expect(readFileSync(database, 'utf8')).toBe('untouched database');
      expect(existsSync(join(home, 'token'))).toBe(false);
      expect(existsSync(join(home, 'runtime-controller.json'))).toBe(false);
      expect(existsSync(join(home, 'runtime.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
