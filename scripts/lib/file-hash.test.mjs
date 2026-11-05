import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256File } from './file-hash.mjs';

test('archive hashing matches complete-buffer digests and propagates read failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'puddle-file-hash-'));
  try {
    const file = join(root, 'synthetic.bin');
    for (const content of ['', 'synthetic archive ✓', 'chunk\0'.repeat(300_000)]) {
      await writeFile(file, content);
      assert.equal(await sha256File(file), createHash('sha256').update(content).digest('hex'));
    }
    await assert.rejects(sha256File(join(root, 'missing')), { code: 'ENOENT' });
    await assert.rejects(sha256File(root), { code: 'EISDIR' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
