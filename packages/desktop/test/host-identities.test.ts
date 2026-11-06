import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  loadHostIdentities,
  parseHostIdentity,
  saveHostIdentity,
  type HostIdentity,
} from '../src/host-identities.js';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));
const identity: HostIdentity = {
  name: 'Research laptop',
  colour: '#12a6bc',
  icon: [{ tag: 'path', attrs: { d: 'M3 3h18v18H3z' } }],
};

it('keeps local and SSH identities separate across restarts and allows clearing colour', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-host-identities-'));
  homes.push(home);
  const file = join(home, 'identities.json');
  saveHostIdentity(file, 'local', identity);
  saveHostIdentity(file, 'user@server', { ...identity, name: 'Compute', colour: 'green' });
  expect(loadHostIdentities(file).get('local')).toEqual(identity);
  expect(loadHostIdentities(file).get('user@server')?.name).toBe('Compute');
  saveHostIdentity(file, 'local', { ...identity, colour: null });
  expect(loadHostIdentities(file).get('local')?.colour).toBeNull();
  expect(loadHostIdentities(file).get('user@server')?.colour).toBe('green');
  writeFileSync(file, '{broken');
  expect(loadHostIdentities(file).size).toBe(0);
});

it('rejects scripts, event attributes, external SVG resources and unbounded drawings', () => {
  expect(parseHostIdentity(identity)).toEqual(identity);
  for (const icon of [
    [{ tag: 'script', attrs: {} }],
    [{ tag: 'path', attrs: { onclick: 'alert(1)' } }],
    [{ tag: 'use', attrs: { href: 'https://example.com/icon.svg' } }],
    [{ tag: 'path', attrs: { d: 'M1 1'.repeat(5000) } }],
    Array(65).fill(identity.icon[0]),
  ])
    expect(parseHostIdentity({ ...identity, icon })).toBeNull();
  expect(parseHostIdentity({ ...identity, colour: 'url(example)' })).toBeNull();
  expect(parseHostIdentity({ ...identity, name: 'x'.repeat(257) })).toBeNull();
});
