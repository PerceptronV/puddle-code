import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusDetector } from '../../src/pty/status-detector.js';
import { codex } from '../../src/agents/codex/index.js';

const idle =
  '› Ask Codex to do anything\n\n  GPT-6-Astra medium fast · ~/project\n  ? for shortcuts';
const busy = `◦ Working (12s • esc to interrupt)\n\n${idle}`;

afterEach(() => vi.useRealTimers());

describe('Codex rendered status fallback', () => {
  it('recognises an idle footer after partial redraws have displaced the raw prompt', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    let screen = busy;
    const detector = new StatusDetector(
      codex.statusPatterns,
      {
        onStatus: (status) => statuses.push(status),
      },
      2000,
      async () => screen,
    );
    detector.feed('Working (12s • esc to interrupt)');
    await vi.advanceTimersByTimeAsync(2100);
    expect(statuses).toEqual(['running']);
    screen = idle;
    detector.feed('\x1b[2K' + 'finished output '.repeat(200));
    await vi.advanceTimersByTimeAsync(2100);
    expect(statuses).toEqual(['running', 'waiting_input']);
    screen = busy;
    detector.feed('Working (1s • esc to interrupt)');
    await vi.advanceTimersByTimeAsync(2100);
    expect(statuses).toEqual(['running', 'waiting_input', 'running']);
    detector.dispose();
  });

  it('ignores stale screen reads and does not infer completion from missing evidence', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    let finish!: (screen: string) => void;
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const detector = new StatusDetector(
      codex.statusPatterns,
      {
        onStatus: (status) => statuses.push(status),
      },
      2000,
      read,
    );
    detector.feed('output');
    await vi.advanceTimersByTimeAsync(2000);
    detector.feed('new turn');
    finish(idle);
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses).toEqual(['running']);
    finish('');
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses).toEqual(['running']);
    detector.feed('redraw');
    await vi.advanceTimersByTimeAsync(2000);
    detector.dispose();
    finish(idle);
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses).toEqual(['running']);
  });
});
