import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readHostUpdateLedger } from '../../src/node/installation/updates.js';
import { HOST_UPDATE_RECORD_BYTES } from '../../src/installation/update.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-ledger-reader-'));
  homes.push(home);
  mkdirSync(join(home, 'updates'), { mode: 0o700 });
  const current = {
    format: 1,
    id: randomUUID(),
    revision: 1,
    created_at: 1,
    updated_at: 1,
    phase: 'checking',
    targets: [{ component: 'daemon', version: '0.4.0' }],
    stages: [],
    preflight: null,
    approved: null,
    dispatch_id: null,
    worker_id: null,
    verification: null,
    message: null,
  };
  const ledger = { format: 1, current, history: [] };
  const file = join(home, 'updates/operations.json');
  writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 });
  return { home, file, ledger };
}

it('reads without application/database writes, migrates owned legacy permissions, and leaves missing homes absent', () => {
  const f = fixture();
  chmodSync(f.home, 0o755);
  const before = readFileSync(f.file);
  expect(readHostUpdateLedger(f.home)).toEqual(f.ledger);
  expect(statSync(f.home).mode & 0o777).toBe(0o700);
  expect(readFileSync(f.file)).toEqual(before);
  expect(existsSync(join(f.home, 'puddle.db'))).toBe(false);
  const missing = join(f.home, 'missing');
  expect(readHostUpdateLedger(missing)).toEqual({ format: 1, current: null, history: [] });
  expect(existsSync(missing)).toBe(false);
});

it.each(['home', 'directory', 'file', 'size', 'corrupt', 'digest'] as const)(
  'refuses unsafe or invalid %s evidence',
  (kind) => {
    const f = fixture();
    if (kind === 'home') chmodSync(f.home, 0o777);
    else if (kind === 'directory') {
      rmSync(join(f.home, 'updates'), { recursive: true });
      symlinkSync(f.home, join(f.home, 'updates'));
    } else if (kind === 'file') {
      rmSync(f.file);
      symlinkSync(join(f.home, 'missing'), f.file);
    } else if (kind === 'size') writeFileSync(f.file, ' '.repeat(HOST_UPDATE_RECORD_BYTES + 1));
    else if (kind === 'corrupt') writeFileSync(f.file, '{');
    else
      writeFileSync(
        f.file,
        JSON.stringify({
          ...f.ledger,
          current: {
            ...f.ledger.current,
            phase: 'staged',
            stages: [
              {
                digest: '0'.repeat(64),
                record: {
                  format: 1,
                  component: 'daemon',
                  generation: '0.4.0~ABC123',
                  version: '0.4.0',
                  protocol: { major: 25, minor: 11 },
                  archive_sha256: 'a'.repeat(64),
                  tree_sha256: 'b'.repeat(64),
                  checksum_verified: true,
                },
              },
            ],
          },
        }),
      );
    expect(() => readHostUpdateLedger(f.home)).toThrow();
  },
);
