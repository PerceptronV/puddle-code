import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CompilationService, type CompilationEvent } from '../../src/compilation/service.js';
import type { CompilationProvider } from '../../src/compilation/provider.js';
import { DependencyObserver } from '../../src/compilation/dependency-observer.js';
import { ApiError } from '../../src/http/errors.js';

const commandSupport = {
  languageConfiguration: () => ({
    fileType: 'demo',
    variables: [],
    defaults: { on_demand: 'examplec input.demo', eager: 'examplec input.demo' },
  }),
  commandConfiguration: (source: { path: string }) => ({
    filePath: `/source/${source.path}`,
    fileType: 'demo',
    variables: [],
    defaults: { on_demand: 'examplec input.demo', eager: 'examplec input.demo' },
  }),
  validateCommand: () => undefined,
};

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('CompilationService', () => {
  it('selects a provider by extension for on-demand runs', async () => {
    const provider: CompilationProvider = {
      id: 'example',
      displayName: 'Example',
      extensions: ['demo'],
      inputExtensions: ['demo'],
      eager: true,
      capability: () => ({ available: true, executor: 'examplec' }),
      ...commandSupport,
      watchInputs: () => [],
      run: async (source) => ({
        executor: 'examplec',
        source,
        artifacts: [
          {
            role: 'preview',
            media_type: 'text/plain',
            file: { ...source, path: `${source.path}.out` },
          },
        ],
        dependencies: [],
      }),
    };
    const service = new CompilationService([provider]);
    const source = { session: '00000000-0000-0000-0000-000000000000', path: 'input.demo' };
    await expect(service.run({ source })).resolves.toMatchObject({
      provider: 'example',
      executor: 'examplec',
      revision: 1,
      artifacts: [{ file: { path: 'input.demo.out' } }],
    });
    expect(service.interruptionInventory()).toEqual([]);
    await expect(
      service.run({ source: { ...source, path: 'input.unknown' } }),
    ).rejects.toMatchObject({
      code: 'compiler_not_supported',
    });
    service.dispose();
  });

  it('debounces eager dependency changes, emits completion, and cleans up', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'puddle-compile-watch-'));
    const sourcePath = join(directory, 'input.demo');
    writeFileSync(sourcePath, 'one\n');
    let runs = 0;
    const provider: CompilationProvider = {
      id: 'example',
      displayName: 'Example',
      extensions: ['demo'],
      inputExtensions: ['demo'],
      eager: true,
      capability: () => ({ available: true, executor: 'examplec' }),
      ...commandSupport,
      watchInputs: () => [sourcePath],
      run: async (source) => {
        runs += 1;
        return {
          executor: 'examplec',
          source,
          artifacts: [],
          dependencies: [sourcePath],
        };
      },
    };
    const service = new CompilationService([provider]);
    const events: CompilationEvent[] = [];
    service.subscribe((event) => events.push(event));
    const source = {
      session: '00000000-0000-0000-0000-000000000000',
      path: 'input.demo',
    };
    await service.setMode({ source, mode: 'eager' });
    expect(runs).toBe(1);
    const initial = service.interruptionInventory();
    expect(initial).toEqual([
      expect.objectContaining({ source, revision: 1, running: false, watching: true }),
    ]);

    // Atomic replacement is what many editors/agents use; watching the parent
    // directory (plus the stat fallback) must see it as a source change.
    const replacement = join(directory, 'replacement.tmp');
    writeFileSync(replacement, 'two\n');
    renameSync(replacement, sourcePath);
    await waitFor(() => runs === 2);
    expect(service.interruptionInventory()[0]).toMatchObject({
      instance: initial[0]!.instance,
      revision: 2,
      watching: true,
    });
    expect(
      events.some((event) => event.type === 'completed' && event.status.mode === 'eager'),
    ).toBe(true);

    await service.setMode({ source, mode: 'on_demand' });
    expect(service.interruptionInventory()).toEqual([]);
    const stoppedAt = runs;
    writeFileSync(sourcePath, 'four\n');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(runs).toBe(stoppedAt);
    expect(service.status({ source }).mode).toBe('on_demand');
    service.dispose();
  });

  it('coalesces changes during a build into one dirty rerun', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'puddle-compile-coalesce-'));
    const sourcePath = join(directory, 'input.demo');
    writeFileSync(sourcePath, 'one\n');
    let runs = 0;
    let release: (() => void) | undefined;
    const provider: CompilationProvider = {
      id: 'example',
      displayName: 'Example',
      extensions: ['demo'],
      inputExtensions: ['demo'],
      eager: true,
      capability: () => ({ available: true, executor: 'examplec' }),
      ...commandSupport,
      watchInputs: () => [sourcePath],
      run: async (source) => {
        runs += 1;
        if (runs === 2) await new Promise<void>((resolve) => (release = resolve));
        return { executor: 'examplec', source, artifacts: [], dependencies: [sourcePath] };
      },
    };
    const service = new CompilationService([provider]);
    const source = {
      session: '00000000-0000-0000-0000-000000000000',
      path: 'input.demo',
    };
    await service.setMode({ source, mode: 'eager' });
    writeFileSync(sourcePath, 'two\n');
    await waitFor(() => runs === 2);
    expect(service.interruptionInventory()).toEqual([
      expect.objectContaining({ running: true, watching: true, revision: 2 }),
    ]);
    writeFileSync(sourcePath, 'three\n');
    writeFileSync(sourcePath, 'four-and-longer\n');
    // Let both fs.watch and polling callbacks reach the in-flight run.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    release?.();
    await waitFor(() => runs === 3);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(runs).toBe(3);
    service.dispose();
  });

  it('keeps initial inputs watched after a failed eager build', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'puddle-compile-retry-'));
    const sourcePath = join(directory, 'input.demo');
    writeFileSync(sourcePath, 'broken\n');
    let fixed = false;
    let runs = 0;
    const provider: CompilationProvider = {
      id: 'example',
      displayName: 'Example',
      extensions: ['demo'],
      inputExtensions: ['demo'],
      eager: true,
      capability: () => ({ available: true, executor: 'examplec' }),
      ...commandSupport,
      watchInputs: () => [sourcePath],
      run: async (source) => {
        runs += 1;
        if (!fixed) {
          throw new ApiError(422, 'compile_failed', 'source is broken', {
            output: 'input.demo:1: broken expression',
            diagnostics: [
              {
                source,
                severity: 'error',
                message: 'broken expression',
                line: 1,
              },
            ],
          });
        }
        return { executor: 'examplec', source, artifacts: [], dependencies: [sourcePath] };
      },
    };
    const service = new CompilationService([provider]);
    const source = {
      session: '00000000-0000-0000-0000-000000000000',
      path: 'input.demo',
    };
    await expect(service.setMode({ source, mode: 'eager' })).rejects.toThrow('source is broken');
    expect(service.interruptionInventory()).toEqual([
      expect.objectContaining({ running: false, watching: true }),
    ]);
    expect(service.status({ source })).toMatchObject({
      mode: 'eager',
      state: 'failed',
      error: {
        message: 'source is broken',
        output: 'input.demo:1: broken expression',
        diagnostics: [{ source, line: 1, message: 'broken expression' }],
      },
    });
    fixed = true;
    writeFileSync(sourcePath, 'fixed and valid\n');
    await waitFor(() => runs === 2);
    await waitFor(() => service.status({ source }).state === 'succeeded');
    service.dispose();
  });
});

it('drains compilation without cancelling it and coalesces observed eager changes across a maintenance pause', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-compile-pause-'));
  const path = join(directory, 'input.demo');
  writeFileSync(path, 'first');
  let complete!: () => void;
  const running = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const contents: string[] = [];
  let block = false;
  const provider: CompilationProvider = {
    id: 'example',
    displayName: 'Example',
    extensions: ['demo'],
    inputExtensions: ['demo'],
    eager: true,
    capability: () => ({ available: true, executor: 'examplec' }),
    ...commandSupport,
    watchInputs: () => [path],
    run: async (source) => {
      contents.push(readFileSync(path, 'utf8'));
      if (block) await running;
      return { executor: 'examplec', source, artifacts: [], dependencies: [path] };
    },
  };
  const service = new CompilationService([provider]);
  const source = { session: '00000000-0000-0000-0000-000000000000', path: 'input.demo' };
  try {
    await service.setMode({ source, mode: 'eager' });
    block = true;
    const accepted = service.run({ source });
    const hold = service.pause();
    const drained = vi.fn();
    const drain = hold.drain().then(drained);
    await expect(service.run({ source })).rejects.toMatchObject({ code: 'host_maintenance' });
    await expect(service.setMode({ source, mode: 'on_demand' })).rejects.toMatchObject({
      code: 'host_maintenance',
    });
    writeFileSync(path, 'latest');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(contents).toEqual(['first', 'first']);
    expect(drained).not.toHaveBeenCalled();
    complete();
    await accepted;
    await drain;
    expect(contents).toEqual(['first', 'first']);
    hold.release();
    await waitFor(() => contents.length === 3);
    expect(contents).toEqual(['first', 'first', 'latest']);
    const shutdown = service.pause();
    await shutdown.drain();
    service.dispose();
    shutdown.release();
    await expect(service.run({ source })).rejects.toMatchObject({ code: 'host_maintenance' });
  } finally {
    complete();
    service.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

function emptyProvider(): CompilationProvider {
  return {
    id: 'example',
    displayName: 'Example',
    extensions: ['demo'],
    inputExtensions: ['demo'],
    eager: true,
    capability: () => ({ available: true, executor: 'examplec' }),
    ...commandSupport,
    watchInputs: () => [],
    run: vi.fn(async (source) => ({
      executor: 'examplec',
      source,
      artifacts: [],
      dependencies: [],
    })),
  };
}

it('expires unobserved eager targets while retaining targets still read by a client', async () => {
  vi.useFakeTimers();
  const service = new CompilationService([emptyProvider()]);
  const source = { session: '00000000-0000-0000-0000-000000000000', path: 'input.demo' };
  const other = { ...source, path: 'other.demo' };
  try {
    await service.setMode({ source, mode: 'eager' });
    await service.setMode({ source: other, mode: 'eager' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(service.status({ source }).mode).toBe('eager');
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(service.interruptionInventory()).toHaveLength(1);
    expect(service.status({ source }).mode).toBe('eager');
    expect(service.status({ source: other }).mode).toBe('on_demand');
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
});

it.each(['on_demand', 'dispose', 'maintenance'] as const)(
  'does not start an obsolete eager registration after %s while initial stats are pending',
  async (action) => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => (release = resolve));
    const subscribe = vi
      .spyOn(DependencyObserver.prototype, 'subscribe')
      .mockReturnValue({ ready, close: vi.fn() });
    const provider = emptyProvider();
    const service = new CompilationService([provider]);
    const source = { session: '00000000-0000-0000-0000-000000000000', path: 'input.demo' };
    try {
      const pending = service.setMode({ source, mode: 'eager' });
      if (action === 'on_demand') await service.setMode({ source, mode: 'on_demand' });
      else if (action === 'dispose') service.dispose();
      else await service.pause().drain();
      const result =
        action === 'maintenance'
          ? expect(pending).rejects.toMatchObject({ code: 'host_maintenance' })
          : expect(pending).resolves.toMatchObject({ mode: 'on_demand' });
      release();
      await result;
      expect(provider.run).not.toHaveBeenCalled();
    } finally {
      release();
      service.dispose();
      subscribe.mockRestore();
    }
  },
);
