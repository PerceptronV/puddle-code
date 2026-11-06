import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { TerminalScreenStateStore } from '../../../src/pty/terminal-screen-state.js';

const observed = vi.hoisted(() => ({
  phase: 'initial',
  countCells: false,
  captures: [] as Array<{
    phase: string;
    instrumented: boolean;
    cells: number;
    bytes: number;
    elapsedMs: number;
    ansiMs: number;
    heapDelta: number;
    lines: number;
    cols: number;
  }>,
}));
vi.mock('../../../src/pty/screen/serialise.js', async (original) => {
  const actual = await original<typeof import('../../../src/pty/screen/serialise.js')>();
  return {
    ...actual,
    serialiseScreen: (...args: Parameters<typeof actual.serialiseScreen>) => {
      const [terminal, serialiser] = args;
      let cells = 0,
        ansiMs = 0;
      const restore: Array<() => void> = [];
      if (observed.countCells)
        for (const buffer of [terminal.buffer.normal, terminal.buffer.alternate]) {
          const getLine = buffer.getLine;
          buffer.getLine = function (index) {
            const line = getLine.call(buffer, index);
            if (line) {
              const getCell = line.getCell;
              line.getCell = function (...args) {
                cells++;
                return getCell.apply(line, args);
              };
            }
            return line;
          };
          restore.push(() => {
            buffer.getLine = getLine;
          });
        }
      const serialize = serialiser.serialize;
      serialiser.serialize = function (...args) {
        const start = performance.now();
        try {
          return serialize.apply(serialiser, args);
        } finally {
          ansiMs += performance.now() - start;
        }
      };
      const heap = process.memoryUsage().heapUsed;
      const start = performance.now();
      try {
        const result = actual.serialiseScreen(...args);
        observed.captures.push({
          phase: observed.phase,
          instrumented: observed.countCells,
          cells,
          bytes: Buffer.byteLength(result),
          elapsedMs: performance.now() - start,
          ansiMs,
          heapDelta: process.memoryUsage().heapUsed - heap,
          lines: terminal.buffer.normal.length,
          cols: terminal.cols,
        });
        return result;
      } finally {
        serialiser.serialize = serialize;
        restore.forEach((restore) => restore());
      }
    },
  };
});

it('measures bounded checkpoint work for static, spinner and bulk histories', async () => {
  const gc: Array<{ duration: number }> = [];
  const observer = new PerformanceObserver((list) =>
    gc.push(...list.getEntries().map((entry) => ({ duration: entry.duration }))),
  );
  observer.observe({ entryTypes: ['gc'] });
  try {
    for (const phase of ['static', 'spinner', 'bulk']) {
      const home = mkdtempSync(join(tmpdir(), 'puddle-checkpoint-work-'));
      const store = new TerminalScreenStateStore(home);
      let writer: ReturnType<typeof setInterval> | undefined;
      try {
        observed.phase = 'initial';
        store.resize('synthetic', 'agent', 80, 24);
        store.write(
          'synthetic',
          'agent',
          Array.from({ length: 5000 }, (_, i) => `synthetic ${i} ${'x'.repeat(40)}`).join('\r\n'),
        );
        await store.textTail('synthetic', 'agent');
        observed.countCells = true;
        await store.snapshot('synthetic', 'agent');
        observed.countCells = false;
        observed.phase = phase;
        const captureStart = observed.captures.length;
        const gcStart = gc.length;
        global.gc?.();
        const heapBefore = process.memoryUsage().heapUsed;
        const first = await Promise.all(
          Array.from({ length: 4 }, () => store.snapshot('synthetic', 'agent')),
        );
        expect(new Set(first).size).toBe(1);
        let writes = 0;
        if (phase !== 'static')
          writer = setInterval(() => {
            writes++;
            store.write(
              'synthetic',
              'agent',
              phase === 'spinner'
                ? '\x1b[?2026h\x1b[39m\x1b[49m\x1b[0m\x1b[24;3H\x1b[?25h\x1b[?2026l'
                : `\r\n${'synthetic bulk output\r\n'.repeat(50)}`,
            );
          }, 20);
        await new Promise((resolve) => setTimeout(resolve, 2200));
        clearInterval(writer);
        writer = undefined;
        const final = await Promise.all(
          Array.from({ length: 4 }, () => store.snapshot('synthetic', 'agent')),
        );
        expect(new Set(final).size).toBe(1);
        await store.closeAll();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const heapBeforeGc = process.memoryUsage().heapUsed;
        global.gc?.();
        const result = {
          phase,
          writes,
          captures: observed.captures.slice(captureStart),
          heapBefore,
          heapBeforeGc,
          heapAfterGc: process.memoryUsage().heapUsed,
          gcAvailable: typeof global.gc === 'function',
          gc: gc.slice(gcStart),
        };
        if (process.env.PUDDLE_PROFILE_OUTPUT)
          appendFileSync(process.env.PUDDLE_PROFILE_OUTPUT, JSON.stringify(result) + '\n');
      } finally {
        clearInterval(writer);
        await store.closeAll();
        rmSync(home, { recursive: true, force: true });
      }
    }
    if (process.env.PUDDLE_PROFILE_OUTPUT)
      appendFileSync(
        process.env.PUDDLE_PROFILE_OUTPUT,
        JSON.stringify({
          phase: 'cell-count-controls',
          captures: observed.captures.filter((row) => row.instrumented),
        }) + '\n',
      );
  } finally {
    observer.disconnect();
  }
}, 30000);
