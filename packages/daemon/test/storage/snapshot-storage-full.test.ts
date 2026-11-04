import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { screenScratchPath } from '../../src/pty/screen/persistence.js';
import { TerminalScreenStateStore } from '../../src/pty/terminal-screen-state.js';

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  const writes = vi.fn(real.writeFile);
  return {
    ...real,
    writeFile: writes,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      // Inject disk failure at the shared atomic writer's actual opened descriptor.
      handle.writeFile = (data, options) => writes(handle, data, options);
      return handle;
    },
  };
});

it('keeps live snapshots available, removes partial files and retries after ENOSPC', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-screen-full-'));
  const health = vi.fn();
  const store = new TerminalScreenStateStore(home, health);
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let partial: string | null = null;
  vi.mocked(writeFile).mockImplementationOnce(async (file) => {
    await real.writeFile(file, 'partial');
    partial = readFileSync(screenScratchPath(home, 0), 'utf8');
    throw Object.assign(new Error('full'), { code: 'ENOSPC' });
  });
  try {
    store.write('session', 'agent', 'still visible');
    expect(await store.snapshot('session', 'agent')).toContain('still visible');
    await vi.waitFor(() => expect(health).toHaveBeenCalledWith(true), { timeout: 3000 });
    expect(partial).toBe('partial');
    expect(readdirSync(home).filter((name) => name.startsWith('.screen-write-'))).toHaveLength(0);
    expect(await store.snapshot('session', 'agent')).toContain('still visible');
    await vi.waitFor(() => expect(health).toHaveBeenLastCalledWith(false), { timeout: 4000 });
    expect(readdirSync(join(home, 'session'))).toEqual(['agent.terminal.json']);
    expect(
      JSON.parse(readFileSync(join(home, 'session', 'agent.terminal.json'), 'utf8')).data,
    ).toContain('still visible');
  } finally {
    await store.closeAll();
    rmSync(home, { recursive: true, force: true });
  }
});
