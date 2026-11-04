import { performance } from 'node:perf_hooks';
import headless from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import {
  SCREEN_RETAINED_LIMITS,
  ScreenRetainedBudget,
} from '../../../src/pty/screen/retained/budget.js';
import {
  retainedScreen as screen,
  screenLines as text,
} from '../../helpers/pty/retained-screen.js';

const { Terminal } = headless;

describe('retained terminal state', () => {
  it('preserves ordinary ANSI, wide and combining output against pinned xterm', async () => {
    const fixture = screen();
    const plain = new Terminal({ cols: 20, rows: 3, scrollback: 8, allowProposedApi: true });
    try {
      const input =
        'hello\r\n\x1b[31mcoloured\x1b[0m 漢字 e\u0301\r\n' +
        '1234567890123456789界\u0301\r\n' +
        '\x1b[?1049halternate界\x1b[?1049l\x1b[?1000h\x1b[?1006h';
      await new Promise<void>((resolve) => plain.write(input, resolve));
      await fixture.guard.write(input);
      expect(text(fixture.terminal)).toEqual(text(plain));
      expect(fixture.failures).toEqual([]);
      expect(fixture.budget.burstBytes).toBe(0);
    } finally {
      fixture.guard.dispose();
      plain.dispose();
    }
  });

  it('refuses unbounded combining cells across separately completed small writes', async () => {
    const fixture = screen({ combinedUnits: 32 });
    try {
      await fixture.guard.write('a');
      await fixture.guard.write('\u0301'.repeat(20));
      await expect(fixture.guard.write('\u0301'.repeat(20))).rejects.toThrow('combined character');
      expect(
        fixture.terminal.buffer.active.getLine(0)!.getCell(0)!.getChars().length,
      ).toBeLessThanOrEqual(32);
      expect(fixture.failures).toHaveLength(1);
      expect(fixture.budget.burstBytes).toBe(0);
      await expect(fixture.guard.write('later')).rejects.toThrow('combined character');
    } finally {
      fixture.guard.dispose();
    }
    expect(fixture.budget.variableBytes).toBe(0);
    expect(fixture.budget.geometryBytes).toBe(0);
  });

  it('does not accumulate OSC8 links forever on a stationary line', async () => {
    const fixture = screen({ links: 4 });
    try {
      for (let index = 0; index < 4; index++)
        await fixture.guard.write(`\x1b]8;;https://example.invalid/${index}\x07\x1b]8;;\x07`);
      await expect(
        fixture.guard.write('\x1b]8;;https://example.invalid/overflow\x07'),
      ).rejects.toThrow('hyperlink');
      expect(fixture.failures).toHaveLength(1);
    } finally {
      fixture.guard.dispose();
    }
  });

  it('allows an existing exact hyperlink at the entry limit without new retention', async () => {
    const fixture = screen({ links: 1 });
    try {
      for (let index = 0; index < 20; index++)
        await fixture.guard.write('\x1b]8;id=stable;https://example.invalid/\x07x\x1b]8;;\x07');
      expect(fixture.failures).toEqual([]);
    } finally {
      fixture.guard.dispose();
    }
  });

  it('guards REP before upstream allocates its expanded codepoint array', async () => {
    const fixture = screen({ burstBytes: 1024 });
    try {
      await fixture.guard.write('a\x1b[5b');
      expect(text(fixture.terminal)[0]).toMatch(/^aaaaaa/);
      await expect(fixture.guard.write('a\x1b[100000000b')).rejects.toThrow('repeat');
      expect(text(fixture.terminal)[0]).toMatch(/^aaaaaa/);
      expect(fixture.failures).toHaveLength(1);
    } finally {
      fixture.guard.dispose();
    }
  });

  it.each(['\x1b]0;', '\x1bP$q'])(
    'bounds partial control payload %j before termination',
    async (prefix) => {
      const fixture = screen({ sequenceUnits: 64 });
      try {
        await fixture.guard.write(prefix);
        await fixture.guard.write('x'.repeat(16));
        await expect(fixture.guard.write('x'.repeat(32))).rejects.toThrow('control sequence');
        expect(fixture.failures).toHaveLength(1);
      } finally {
        fixture.guard.dispose();
      }
    },
  );

  it('ignores large unsupported OSC and DCS payloads without a false screen gap', async () => {
    const fixture = screen({ sequenceUnits: 64 });
    try {
      await fixture.guard.write(
        '\x1b]9999;' +
          'x'.repeat(16384) +
          '\x1b\\' +
          '\x1bPz' +
          'x'.repeat(16384) +
          '\x1b\\visible',
      );
      expect(fixture.failures).toEqual([]);
      expect(text(fixture.terminal)[0]).toContain('visible');
    } finally {
      fixture.guard.dispose();
    }
  });

  it('reclaims variable credit after old combined lines leave bounded scrollback', async () => {
    const fixture = screen({ variableBytes: 2048, scrollback: 1 }, undefined, 4, 1);
    try {
      for (let index = 0; index < 100; index++) await fixture.guard.write('e\u0301\r\n');
      expect(fixture.failures).toEqual([]);
      expect(fixture.budget.variableBytes).toBeLessThanOrEqual(2048);
    } finally {
      fixture.guard.dispose();
    }
  });

  it('queues competing parses without creating a canonical gap', async () => {
    const first = screen();
    const second = screen({}, first.budget);
    try {
      await Promise.all([
        first.guard.write('first\r\n'.repeat(100)),
        second.guard.write('second\r\n'.repeat(100)),
      ]);
      expect(first.failures).toEqual([]);
      expect(second.failures).toEqual([]);
      expect(first.budget.burstBytes).toBe(0);
    } finally {
      first.guard.dispose();
      second.guard.dispose();
    }
  });

  it('keeps hidden CircularList backing rows charged during a pressure sweep', async () => {
    const fixture = screen();
    try {
      await fixture.guard.write('\x1b[3;1Ha\u0301\u0301');
      const core = fixture.terminal as unknown as {
        _core: {
          _bufferService: { buffers: { normal: { lines: { length: number; pop(): unknown } } } };
        };
      };
      const inspect = fixture.guard as unknown as { inspectVariables(): number };
      const before = inspect.inspectVariables();
      expect(before).toBeGreaterThan(0);
      // Pinned CircularList.pop leaves its backing-array row referenced.
      core._core._bufferService.buffers.normal.lines.pop();
      expect(inspect.inspectVariables()).toBe(before);
    } finally {
      fixture.guard.dispose();
    }
  });

  it('cancels old buffer cleanup and marker ownership on RIS and disposal', async () => {
    const fixture = screen();
    const core = fixture.terminal as unknown as {
      _core: {
        _bufferService: {
          buffers: {
            normal: { markers: Array<{ dispose(): void }>; _memoryCleanupQueue: { clear(): void } };
          };
        };
      };
    };
    try {
      await fixture.guard.write('\x1b]8;;https://example.invalid\x07x');
      const old = core._core._bufferService.buffers.normal;
      const clear = vi.spyOn(old._memoryCleanupQueue, 'clear');
      const marker = vi.spyOn(old.markers[0]!, 'dispose');
      await fixture.guard.write('\x1bc');
      expect(core._core._bufferService.buffers.normal).not.toBe(old);
      expect(clear).toHaveBeenCalledOnce();
      expect(marker).toHaveBeenCalled();
      const finalClear = vi.spyOn(
        core._core._bufferService.buffers.normal._memoryCleanupQueue,
        'clear',
      );
      fixture.guard.dispose();
      expect(finalClear).toHaveBeenCalledOnce();
    } finally {
      fixture.guard.dispose();
    }
  });

  it('rebalances old scrollback across screens while retaining their viewports', async () => {
    const budget = new ScreenRetainedBudget({
      ...SCREEN_RETAINED_LIMITS,
      geometryBytes: 64 * 1024,
    });
    const first = screen({}, budget);
    await first.guard.write('history\r\n'.repeat(100));
    const before = first.terminal.options.scrollback!;
    const second = screen({}, budget);
    try {
      expect(first.terminal.options.scrollback!).toBeLessThan(before);
      expect(first.terminal.rows).toBe(3);
      expect(second.terminal.rows).toBe(3);
      expect(budget.geometryBytes).toBeLessThanOrEqual(64 * 1024);
      await first.guard.resize(10, 2);
      expect(first.guard.lease.cols).toBe(20);
      expect(first.guard.lease.rows).toBe(3);
      expect(budget.geometryBytes).toBeLessThanOrEqual(64 * 1024);
    } finally {
      first.guard.dispose();
      second.guard.dispose();
    }
  });

  it('retains the whole REP burst charge until the write callback settles', async () => {
    const fixture = screen({ burstBytes: 128 });
    try {
      await expect(fixture.guard.write('a\x1b[20bb\x1b[20b')).rejects.toThrow('repeat');
      expect(fixture.budget.burstBytes).toBe(0);
    } finally {
      fixture.guard.dispose();
    }
  });

  it('holds a rejected batch until every actual xterm callback has settled', async () => {
    const fixture = screen({ combinedUnits: 8 });
    const callbacks: Array<() => void> = [];
    const original = fixture.terminal.write.bind(fixture.terminal);
    vi.spyOn(fixture.terminal, 'write').mockImplementation((data, callback) => {
      original(data, () => {
        if (callback) callbacks.push(callback);
      });
    });
    const pending = fixture.guard.write('a' + '\u0301'.repeat(9) + 'x'.repeat(8192));
    const rejected = expect(pending).rejects.toThrow('combined character');
    try {
      await vi.waitFor(() => expect(callbacks).toHaveLength(3));
      expect(fixture.budget.burstBytes).toBe(SCREEN_RETAINED_LIMITS.burstBytes);
      callbacks.shift()!();
      callbacks.shift()!();
      await Promise.resolve();
      expect(fixture.budget.burstBytes).toBe(SCREEN_RETAINED_LIMITS.burstBytes);
      callbacks.shift()!();
      await rejected;
      expect(fixture.budget.burstBytes).toBe(0);
      expect(fixture.terminal.buffer.active.getLine(0)!.translateToString()).not.toContain('x');
    } finally {
      for (const callback of callbacks) callback();
      await rejected;
      fixture.guard.dispose();
    }
  });

  it.each(['\x1b]0;', '\x1b]1;', '\x1b]2;'])(
    'bounds title and icon retention %j',
    async (prefix) => {
      const fixture = screen({ titleUnits: 4 });
      try {
        await expect(fixture.guard.write(`${prefix}oversized\x07`)).rejects.toThrow('title');
      } finally {
        fixture.guard.dispose();
      }
    },
  );

  it('bounds new line markers on a single active hyperlink', async () => {
    const fixture = screen({ markers: 3 });
    try {
      await expect(
        fixture.guard.write('\x1b]8;;https://example.invalid\x07a\r\nb\r\nc\r\nd'),
      ).rejects.toThrow('marker');
    } finally {
      fixture.guard.dispose();
    }
  });

  it('rejects unaffordable viewport/reflow before allocating extreme geometry', async () => {
    const fixture = screen({ burstBytes: 4096 }, undefined, 20, 3);
    try {
      await fixture.guard.write('x'.repeat(60));
      await expect(fixture.guard.resize(2, 1000)).rejects.toThrow('reflow');
      expect(fixture.terminal.cols).toBe(20);
      expect(fixture.terminal.rows).toBe(3);
      expect(fixture.budget.burstBytes).toBe(0);
    } finally {
      fixture.guard.dispose();
    }
  });

  it('keeps ordinary bounded output inexpensive without per-write history scans', async () => {
    const fixture = screen({}, undefined, 120, 32);
    const input = 'ordinary plain output '.repeat(2000);
    try {
      const started = performance.now();
      await fixture.guard.write(input);
      expect(fixture.failures).toEqual([]);
      expect(fixture.budget.variableBytes).toBe(0);
      // A regression ceiling, not a claim about production throughput or RSS.
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      fixture.guard.dispose();
    }
  });
});
