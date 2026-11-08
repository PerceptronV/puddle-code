import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { huddleSaveSchema, HUDDLE_LIMITS } from '@puddle/shared';
import { createHuddleDefinition } from '../../../src/huddle/definitions/create.js';
import { captureHuddleDefinition } from '../../../src/huddle/definitions/capture.js';
import { saveHuddleDefinition, saveHuddleSource } from '../../../src/huddle/definitions/save.js';
import { coreHuddleComponents } from '@puddle/shared';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const worktree = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'puddle-huddle-save-')));
  roots.push(worktree);
  const definition = createHuddleDefinition(worktree, 'Draft');
  const root = join(worktree, '.puddle/huddle', definition.id);
  const manifest = join(root, 'huddle.json');
  const capture = () => captureHuddleDefinition(worktree, definition.id, coreHuddleComponents);
  const snapshot = await capture();
  const edit = { file: 'huddle.json' as const, value: { ...definition, name: 'Changed' } };
  const check = vi.fn();
  const save = () => saveHuddleDefinition(worktree, snapshot, edit, check);
  return { worktree, root, manifest, capture, snapshot, edit, check, save };
}

it('publishes deterministic manifest/layout files independently, preserves mode and unrelated source, and skips identical writes', async () => {
  const f = await fixture();
  fs.chmodSync(f.manifest, 0o640);
  fs.writeFileSync(join(f.root, 'README.md'), 'Keep this explanation');
  f.save();
  expect(fs.statSync(f.manifest).mode & 0o777).toBe(0o640);
  expect(fs.readFileSync(f.manifest, 'utf8')).toBe(`${JSON.stringify(f.edit.value, null, 2)}\n`);
  const next = await f.capture();
  const mtime = fs.statSync(f.manifest).mtimeMs;
  saveHuddleDefinition(f.worktree, next, f.edit, f.check);
  expect(fs.statSync(f.manifest).mtimeMs).toBe(mtime);
  saveHuddleDefinition(
    f.worktree,
    next,
    {
      file: 'layout.json',
      value: { format: 1, nodes: { review: { x: -100, y: 50 } } },
    },
    f.check,
  );
  expect((await f.capture()).layout?.nodes.review).toEqual({ x: -100, y: 50 });
  expect(fs.statSync(f.manifest).mtimeMs).toBe(mtime);
  expect(fs.readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('Keep this explanation');
  expect(fs.readdirSync(f.root).sort()).toEqual(['README.md', 'huddle.json', 'layout.json']);
});

it('detects edits to captured script dependencies, not just the manifest', async () => {
  const f = await fixture();
  fs.mkdirSync(join(f.root, 'nodes'));
  fs.writeFileSync(
    join(f.root, 'nodes/node.json'),
    JSON.stringify({
      format: 1,
      id: 'test.echo',
      version: 1,
      category: 'script',
      inputs: { value: { schema: {} } },
      title: 'Echo',
      entry: 'run.ts',
    }),
  );
  fs.writeFileSync(join(f.root, 'nodes/run.ts'), 'throw new Error("never evaluate")');
  fs.writeFileSync(
    f.manifest,
    JSON.stringify({
      ...f.snapshot.definition,
      nodes: [
        { id: 'echo', source: { kind: 'local', manifest: './nodes/node.json' }, parameters: {} },
      ],
    }),
  );
  const snapshot = await f.capture();
  expect(snapshot.files['nodes/run.ts']).toBe('throw new Error("never evaluate")');
  fs.writeFileSync(join(f.root, 'nodes/run.ts'), '// changed externally');
  expect(() => saveHuddleDefinition(f.worktree, snapshot, f.edit, f.check)).toThrow(
    /source changed/,
  );
  expect(() =>
    saveHuddleSource(
      f.worktree,
      snapshot,
      { file: f.edit.file, content: JSON.stringify(f.edit.value) },
      f.check,
    ),
  ).toThrow(/source changed/);
  expect(JSON.parse(fs.readFileSync(f.manifest, 'utf8')).name).toBe('Draft');
});

it('preserves exact validated text, including CRLF, Unicode, omitted defaults and no final newline', async () => {
  const f = await fixture();
  const content = `{\r\n\t"edges": [], "nodes": [], "name": "Café 🦆", "id": "${f.snapshot.definition.id}", "format": 1\r\n}`;
  saveHuddleSource(f.worktree, f.snapshot, { file: 'huddle.json', content }, f.check);
  expect(fs.readFileSync(f.manifest, 'utf8')).toBe(content);
  const next = await f.capture();
  expect(next.files['huddle.json']).toBe(content);
  const rename = vi.spyOn(fs, 'renameSync');
  saveHuddleSource(f.worktree, next, { file: 'huddle.json', content }, f.check);
  expect(rename).not.toHaveBeenCalled();
  for (const bad of [
    content.replace('"format": 1', '"format": 2'),
    content.replace('"format": 1', '"future": true, "format": 1'),
    content.replace('Café 🦆', '\uD800'),
    '\uFEFF' + content,
  ])
    expect(() =>
      saveHuddleSource(f.worktree, next, { file: 'huddle.json', content: bad }, f.check),
    ).toThrow();
  expect(fs.readFileSync(f.manifest, 'utf8')).toBe(content);
});

it('retains a script byte-order mark in capture and subsequent source guards', async () => {
  const f = await fixture();
  fs.writeFileSync(
    join(f.root, 'node.json'),
    JSON.stringify({
      format: 1,
      id: 'test.bom',
      version: 1,
      category: 'script',
      title: 'BOM',
      entry: 'run.ts',
      inputs: { value: { schema: {} } },
    }),
  );
  const content = '\uFEFF// a retained script\r\n';
  fs.writeFileSync(join(f.root, 'run.ts'), content);
  fs.writeFileSync(
    f.manifest,
    JSON.stringify({
      ...f.snapshot.definition,
      nodes: [{ id: 'script', source: { kind: 'local', manifest: 'node.json' } }],
    }),
  );
  const snapshot = await f.capture();
  expect(snapshot.files['run.ts']).toBe(content);
  saveHuddleSource(
    f.worktree,
    snapshot,
    { file: 'layout.json', content: '{"nodes":{}, "format":1}' },
    f.check,
  );
  expect(fs.readFileSync(join(f.root, 'run.ts'), 'utf8')).toBe(content);
});

it.each(['write', 'rename'] as const)(
  'keeps original source and removes staging files after a %s failure',
  async (stage) => {
    const f = await fixture();
    const original = fs.readFileSync(f.manifest, 'utf8');
    if (stage === 'write')
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw new Error('Disk full');
      });
    else
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('Rename denied');
      });
    expect(f.save).toThrow();
    expect(fs.readFileSync(f.manifest, 'utf8')).toBe(original);
    expect(fs.readdirSync(f.root)).toEqual(['huddle.json']);
  },
);

it('rechecks source and authority after staging, before publication', async () => {
  const f = await fixture();
  const original = fs.readFileSync(f.manifest, 'utf8');
  const fsync = fs.fsyncSync;
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce((fd) => {
    fsync(fd);
    fs.writeFileSync(f.manifest, `${original}\n`);
  });
  expect(f.save).toThrow(/source changed/);
  expect(fs.readFileSync(f.manifest, 'utf8')).toBe(`${original}\n`);
  expect(fs.readdirSync(f.root)).toEqual(['huddle.json']);
  fs.writeFileSync(f.manifest, original);
  f.check.mockClear();
  f.check
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('Revoked');
    });
  expect(f.save).toThrow('Revoked');
  expect(fs.readFileSync(f.manifest, 'utf8')).toBe(original);
  expect(fs.readdirSync(f.root)).toEqual(['huddle.json']);
});

it('keeps the published source after a directory flush failure so inspection can resolve a lost save', async () => {
  const f = await fixture();
  const sync = fs.fsyncSync;
  vi.spyOn(fs, 'fsyncSync')
    .mockImplementationOnce(sync)
    .mockImplementationOnce(() => {
      throw new Error('Directory flush failed');
    });
  expect(f.save).toThrow('Directory flush failed');
  expect((await f.capture()).definition).toEqual(f.edit.value);
  expect(fs.readdirSync(f.root)).toEqual(['huddle.json']);
});

it.each(['files', 'bytes'] as const)(
  'refuses a layout addition which would exceed the captured bundle %s limit',
  async (limit) => {
    const f = await fixture();
    const count = limit === 'files' ? HUDDLE_LIMITS.files - 2 : 16;
    const scripts = Array.from({ length: count }, (_, index) => `source-${index}.ts`);
    const component = JSON.stringify({
      format: 1,
      id: 'test.large',
      version: 1,
      category: 'script',
      title: 'Large',
      entry: scripts[0],
      dependencies: scripts.slice(1),
      inputs: { value: { schema: {} } },
    });
    const definition = JSON.stringify({
      ...f.snapshot.definition,
      nodes: [{ id: 'large', source: { kind: 'local', manifest: './node.json' } }],
    });
    fs.writeFileSync(join(f.root, 'node.json'), component);
    fs.writeFileSync(f.manifest, definition);
    let remaining =
      HUDDLE_LIMITS.bundleBytes - Buffer.byteLength(component) - Buffer.byteLength(definition);
    for (const script of scripts) {
      const size = limit === 'files' ? 1 : Math.min(HUDDLE_LIMITS.fileBytes, remaining);
      fs.writeFileSync(join(f.root, script), ' '.repeat(size));
      remaining -= size;
    }
    const snapshot = await f.capture();
    expect(() =>
      saveHuddleDefinition(
        f.worktree,
        snapshot,
        { file: 'layout.json', value: { format: 1, nodes: {} } },
        f.check,
      ),
    ).toThrow(/capture limit/);
    expect(fs.existsSync(join(f.root, 'layout.json'))).toBe(false);
    expect(fs.readdirSync(f.root).some((name) => name.startsWith('.puddle-save-'))).toBe(false);
  },
);

it.each(['manifest', 'layout', 'root'] as const)(
  'refuses a %s symlink without touching its target',
  async (target) => {
    const f = await fixture();
    const outside = join(f.worktree, 'outside');
    if (target === 'root') {
      fs.renameSync(f.root, outside);
      fs.symlinkSync(outside, f.root);
    } else {
      fs.writeFileSync(outside, 'outside');
      if (target === 'manifest') fs.unlinkSync(f.manifest);
      fs.symlinkSync(outside, target === 'manifest' ? f.manifest : join(f.root, 'layout.json'));
    }
    expect(f.save).toThrow(/source changed/);
    if (target !== 'root') expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
    else
      expect(JSON.parse(fs.readFileSync(join(outside, 'huddle.json'), 'utf8')).name).toBe('Draft');
  },
);

it('refuses identity changes, future formats/unknown fields and oversized serialized files', async () => {
  const f = await fixture();
  expect(() =>
    saveHuddleDefinition(
      f.worktree,
      f.snapshot,
      { ...f.edit, value: { ...f.edit.value, id: 'f'.repeat(32) } },
      f.check,
    ),
  ).toThrow(/directory id/);
  const input = {
    project_id: 'a'.repeat(10),
    worktree: f.worktree,
    huddle_id: f.snapshot.definition.id,
    expected_digest: f.snapshot.digest,
    edit: f.edit,
  };
  for (const value of [
    { ...f.edit.value, format: 2 },
    { ...f.edit.value, future: true },
  ]) {
    expect(huddleSaveSchema.safeParse({ ...input, edit: { ...f.edit, value } }).success).toBe(
      false,
    );
  }
  expect(() =>
    saveHuddleDefinition(
      f.worktree,
      f.snapshot,
      { ...f.edit, value: { ...f.edit.value, description: 'x'.repeat(HUDDLE_LIMITS.fileBytes) } },
      f.check,
    ),
  ).toThrow(/size limit/);
  expect(fs.readdirSync(f.root)).toEqual(['huddle.json']);
});
