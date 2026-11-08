import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// These fixtures use chromium.launch({ headless: true }) and the UI-only preview.
// They never launch Electron, move the OS pointer, or start a daemon.
const cases = {
  'pane-return': ['test/dev/window-transfer.mjs', { WINDOW_DOCK_BACK: '1' }],
  'pane-drag': [
    'test/dev/window-transfer.mjs',
    { WINDOW_DOCK_BACK: 'drag', WINDOW_LAYOUT_HANDSHAKE: '1' },
  ],
  'file-menu': ['test/dev/window-transfer.mjs', { WINDOW_TRANSFER_KIND: 'file' }],
  'file-drop': ['test/dev/window-transfer.mjs', { WINDOW_ADD_TAB: 'file' }],
  'tab-drop': ['test/dev/window-transfer.mjs', { WINDOW_ADD_TAB: 'tab' }],
  'session-drop': ['test/dev/window-transfer.mjs', { WINDOW_ADD_TAB: 'session' }],
  'session-effects': [
    'test/dev/window-transfer.mjs',
    { WINDOW_TRANSFER_KIND: 'session', WINDOW_EFFECTS: '1' },
  ],
  'project-layouts': [
    'test/dev/window-transfer.mjs',
    { WINDOW_TRANSFER_KIND: 'project', WINDOW_DOCK_BACK: 'drag', WINDOW_LAYOUT_APPLY: '1' },
  ],
  'layout-catalogue': [
    'test/dev/window-transfer.mjs',
    { WINDOW_TRANSFER_KIND: 'project', WINDOW_DOCK_BACK: 'drag', WINDOW_LAYOUT_CATALOGUE: '1' },
  ],
  'browser-layouts': ['test/dev/layouts/catalogue.mjs', {}],
  'browser-drag': ['test/dev/pane-drag.mjs', {}],
  'browser-workspace': ['test/dev/workspace-transitions.mjs', {}],
  'browser-components': ['test/dev/browser.mjs', {}],
};
const selected = process.argv.slice(2);
const names = selected.length ? selected : Object.keys(cases);
for (const name of names)
  assert.ok(Object.hasOwn(cases, name), `Unknown headless window case: ${name}`);
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('WINDOW_')) delete env[key];
const cwd = fileURLToPath(new URL('../../../', import.meta.url));
for (const name of names) {
  const [script, options] = cases[name];
  console.log(`Headless windows: ${name}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env: { ...env, ...options },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${name} failed (${signal ?? code})`)),
    );
  });
}
console.log(
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    result: 'passed',
    cases: names,
  }),
);
