import { isStorageFull } from '../storage/errors.js';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import headless, {
  type ITerminalAddon as HeadlessTerminalAddon,
  type Terminal as HeadlessTerminal,
} from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { RuntimeBufferBudget } from '../runtime/resources/budget.js';
import { SCREEN_LIMITS, screenActionBytes } from './screen/limits.js';
import { ScreenParserQueue } from './screen/queue.js';
import { ScreenSnapshotWork } from './screen/work.js';
import { readScreenFile } from './screen/files.js';
import { ScreenSnapshotFiles } from './screen/persistence.js';
import { serialiseScreen } from './screen/serialise.js';
import { preserveXtermScrollUp } from './xterm-scrollback.js';

const { Terminal } = headless;

// These packages are exact-pinned as a pair: 0.14.0 and 6.0.0 were built
// from the same xterm commit. SerializeAddon uses the headless buffer API (and
// some xterm internals), so allowing independent semver drift would make this
// restoration boundary less stable than the public-looking package names imply.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

const PERSIST_AFTER_IDLE_MS = 1_000;
const STATE_SUFFIX = '.terminal.json';

interface PersistedTerminalState {
  version: 1;
  cols: number;
  rows: number;
  data: string;
}

interface ScreenState {
  terminal: HeadlessTerminal;
  serialiser: SerializeAddon;
  cols: number;
  rows: number;
  hasContent: boolean;
  dirty: boolean;
  queue: ScreenParserQueue;
  revision: number;
  unavailable: boolean;
  saving: Promise<void> | null;
  forgotten: boolean;
  persistTimer: NodeJS.Timeout | null;
  generation: number;
}

/**
 * Canonical terminal emulators for daemon-owned PTYs.
 *
 * A raw suffix of PTY output is not a terminal snapshot: it may begin halfway
 * through a cursor-addressed redraw and can therefore restore as a blank page
 * or a few displaced fragments. This store parses the complete live stream in
 * a headless xterm and serialises a self-contained ANSI snapshot for attach.
 * Snapshots are also written beside the logs so daemon restarts do not discard
 * the last visible screen and a bounded whole-line scrollback suffix.
 */
export class TerminalScreenStateStore {
  private readonly states = new Map<string, ScreenState>();
  private readonly gaps = new Set<string>();
  private readonly files?: ScreenSnapshotFiles;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  private readonly parserBudget: RuntimeBufferBudget;
  // Reader traffic cannot use up the input capacity and force a canonical gap.
  private readonly captureBudget = new RuntimeBufferBudget({
    bytes: SCREEN_LIMITS.captureBytes,
    count: SCREEN_LIMITS.captureActions,
  });
  private readonly work: ScreenSnapshotWork;

  private retryAt = 0;
  private retryMs = 1000;
  constructor(
    private readonly stateDir?: string,
    private readonly onHealth?: (degraded: boolean) => void,
    options: { parserBudget?: RuntimeBufferBudget; transientBudget?: RuntimeBufferBudget } = {},
  ) {
    this.parserBudget =
      options.parserBudget ??
      new RuntimeBufferBudget({
        bytes: SCREEN_LIMITS.parserBytes,
        count: SCREEN_LIMITS.parserActions,
      });
    this.work = new ScreenSnapshotWork(options.transientBudget);
    if (stateDir) this.files = new ScreenSnapshotFiles(stateDir);
  }

  write(stream: string, term: string, data: string): void {
    if (data === '' || this.closing || this.gaps.has(this.key(stream, term))) return;
    const state = this.ensure(stream, term);
    state.queue.enqueue(screenActionBytes(data), async () => {
      await this.writeTerminal(state.terminal, data);
      state.hasContent = true;
      state.revision++;
      state.dirty = true;
      this.schedulePersist(stream, term, state);
    });
  }

  resize(stream: string, term: string, cols: number, rows: number): void {
    if (this.closing || this.gaps.has(this.key(stream, term)) || !this.validSize(cols, rows))
      return;
    const state = this.ensure(stream, term);
    state.queue.enqueue(screenActionBytes(), () => {
      if (state.cols === cols && state.rows === rows) return Promise.resolve();
      state.terminal.resize(cols, rows);
      state.cols = cols;
      state.rows = rows;
      state.revision++;
      state.dirty = true;
      this.schedulePersist(stream, term, state);
      return Promise.resolve();
    });
  }

  /** Returns null only when this terminal has never produced restorable data. */
  async snapshot(stream: string, term: string): Promise<string | null> {
    const state = this.ensure(stream, term);
    return state.queue.capture(screenActionBytes(), () => {
      this.requireAvailable(state);
      if (!state.hasContent) return null;
      const release = this.work.tryAcquire();
      if (!release) throw new Error('Terminal snapshot work capacity exceeded');
      try {
        return this.serialise(state);
      } finally {
        release();
      }
    });
  }

  /** Bounded plain text for notification previews, without changing terminal geometry. */
  async textTail(stream: string, term: string): Promise<string> {
    const state = this.states.get(this.key(stream, term));
    if (!state) return '';
    if (state.unavailable || state.forgotten) return '';
    return state.queue.capture(screenActionBytes(), () => {
      if (state.unavailable) return '';
      const buffer = state.terminal.buffer.active;
      const lines: string[] = [];
      // Reading the parsed screen avoids ANSI redraw fragments and OSC payloads.
      const end = Math.min(buffer.length, buffer.baseY + buffer.cursorY + 1);
      for (let row = Math.max(0, end - 32); row < end; row++) {
        const line = buffer.getLine(row);
        const text = line?.translateToString(true) ?? '';
        if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      return lines.join('\n');
    });
  }

  /** Persist and release an exited PTY's in-memory buffer. */
  async release(stream: string, term: string): Promise<void> {
    const key = this.key(stream, term);
    const state = this.states.get(key);
    if (!state) return;
    const generation = state.generation;
    await this.flush(stream, term, state);
    if (this.closing || this.states.get(key) !== state) return;
    if (state.unavailable) {
      // Retain only a key: an attach must not reload the old disk screen, while
      // an exited terminal's full emulator no longer needs to stay in memory.
      this.gaps.add(key);
    } else if (state.generation !== generation) return;
    if (state.persistTimer) clearTimeout(state.persistTimer);
    state.forgotten = true;
    state.queue.close();
    state.terminal.dispose();
    this.states.delete(key);
  }

  /** Persist every live state before daemon shutdown. */
  closeAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const entries = [...this.states.entries()];
    this.closePromise = (async () => {
      // Do not manufacture one serialisation waiter per state during shutdown.
      for (const [key, state] of entries) {
        const [stream, term] = this.split(key);
        await this.flush(stream, term, state);
        if (state.persistTimer) clearTimeout(state.persistTimer);
        state.forgotten = true;
        state.queue.close();
        state.terminal.dispose();
      }
      this.states.clear();
      this.gaps.clear();
    })();
    return this.closePromise;
  }

  /** Delete buffers for a stream that has been permanently removed. */
  async forget(stream: string): Promise<void> {
    const prefix = `${stream} `;
    for (const key of this.gaps) if (key.startsWith(prefix)) this.gaps.delete(key);
    for (const [key, state] of [...this.states]) {
      if (!key.startsWith(prefix)) continue;
      state.forgotten = true;
      state.queue.close();
      if (state.persistTimer) clearTimeout(state.persistTimer);
      await state.queue.settled;
      await state.saving;
      state.terminal.dispose();
      this.states.delete(key);
    }
    if (!this.stateDir) return;
    const dir = join(this.stateDir, stream);
    try {
      const files = await readdir(dir);
      await Promise.all(
        files.filter((file) => file.endsWith(STATE_SUFFIX)).map((file) => unlink(join(dir, file))),
      );
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }
  }

  private ensure(stream: string, term: string): ScreenState {
    if (this.closing) throw new Error('Terminal screen store is shutting down');
    const key = this.key(stream, term);
    if (this.gaps.has(key))
      throw new Error('Canonical terminal screen is unavailable after an input gap');
    const existing = this.states.get(key);
    if (existing) {
      existing.generation++;
      return existing;
    }

    const terminal = new Terminal({
      // Narrow opt-in for the official serialiser's buffer access. Puddle does
      // not expose or consume proposed xterm APIs anywhere else.
      allowProposedApi: true,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: SCREEN_LIMITS.scrollbackLines,
    });
    preserveXtermScrollUp(terminal);
    const serialiser = new SerializeAddon();
    // The serialiser is runtime-compatible with @xterm/headless, as documented
    // by xterm, but its published type names the browser Terminal class.
    terminal.loadAddon(serialiser as unknown as HeadlessTerminalAddon);
    const state: ScreenState = {
      terminal,
      serialiser,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      hasContent: false,
      dirty: false,
      queue: new ScreenParserQueue(
        this.parserBudget,
        (error) => {
          state.unavailable = true;
          this.onHealth?.(true);
          console.warn('Canonical terminal screen is unavailable:', error);
        },
        this.captureBudget,
      ),
      revision: 0,
      unavailable: false,
      saving: null,
      forgotten: false,
      persistTimer: null,
      generation: 0,
    };
    state.queue.enqueue(screenActionBytes(), () => this.load(stream, term, state));
    this.states.set(key, state);
    return state;
  }

  private async load(stream: string, term: string, state: ScreenState): Promise<void> {
    const file = this.file(stream, term);
    if (!file) return;
    const release = await this.work.acquire();
    try {
      const parsed: unknown = JSON.parse(await readScreenFile(file));
      if (!this.isPersistedState(parsed)) throw new Error('Invalid saved terminal screen');
      state.terminal.resize(parsed.cols, parsed.rows);
      state.cols = parsed.cols;
      state.rows = parsed.rows;
      if (parsed.data !== '') {
        await this.writeTerminal(state.terminal, parsed.data);
        state.hasContent = true;
      }
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    } finally {
      release();
    }
  }

  private schedulePersist(stream: string, term: string, state: ScreenState): void {
    if (
      !this.stateDir ||
      state.persistTimer ||
      state.saving ||
      state.unavailable ||
      state.forgotten ||
      this.closing
    )
      return;
    state.persistTimer = setTimeout(
      () => {
        state.persistTimer = null;
        void this.persist(stream, term, state).catch((error: unknown) => {
          console.warn(`Could not persist terminal state ${stream}/${term}:`, error);
        });
      },
      Math.max(PERSIST_AFTER_IDLE_MS, this.retryAt - Date.now()),
    );
    state.persistTimer.unref?.();
  }

  private async persist(stream: string, term: string, state: ScreenState): Promise<void> {
    if (state.persistTimer) {
      clearTimeout(state.persistTimer);
      state.persistTimer = null;
    }
    const stateDir = this.stateDir;
    if (!stateDir) {
      await state.queue.settled;
      return;
    }
    if (state.saving) return state.saving;
    const saving = (async () => {
      await state.queue.settled;
      if (!state.dirty || state.unavailable || state.forgotten) return;
      if (Date.now() < this.retryAt) return;
      const file = this.file(stream, term);
      if (!file) return;
      let release: (() => void) | undefined;
      try {
        // No output strings are retained while waiting for a bounded work slot.
        release = await this.work.acquire();
        if (state.unavailable || state.forgotten) return;
        const { revision, json } = await state.queue.capture(screenActionBytes(), () => {
          const persisted: PersistedTerminalState = {
            version: 1,
            cols: state.cols,
            rows: state.rows,
            data: this.serialise(state),
          };
          const json = JSON.stringify(persisted);
          if (Buffer.byteLength(json) > SCREEN_LIMITS.fileBytes)
            throw new Error('Terminal snapshot file exceeds its capacity');
          return { revision: state.revision, json };
        });
        // An overflow or permanent removal while IO was pending must not publish
        // an incomplete/newly invalid screen over the last known-good snapshot.
        if (!(await this.files!.save(file, json, () => !state.unavailable && !state.forgotten)))
          return;
        state.dirty = state.revision !== revision;
        this.retryAt = 0;
        this.retryMs = 1000;
        if (!state.unavailable && !state.forgotten) this.onHealth?.(false);
      } catch (error) {
        this.onHealth?.(true);
        this.retryAt = Date.now() + this.retryMs;
        this.retryMs = Math.min(30_000, this.retryMs * 2);
        if (!isStorageFull(error)) console.warn('Could not save terminal snapshot:', error);
      } finally {
        release?.();
      }
    })();
    state.saving = saving;
    try {
      await saving;
    } finally {
      state.saving = null;
      if (state.dirty) this.schedulePersist(stream, term, state);
    }
  }

  private async flush(stream: string, term: string, state: ScreenState): Promise<void> {
    await state.queue.settled;
    await this.persist(stream, term, state);
    // A pre-existing disk write may have captured an older revision. Shutdown
    // and release get one fresh coalesced save, with the normal failure backoff.
    if (state.dirty && !state.unavailable && !state.forgotten)
      await this.persist(stream, term, state);
  }

  /** Attach and disk snapshots share the same bounded whole-line history and modes. */
  private serialise(state: ScreenState): string {
    this.requireAvailable(state);
    return serialiseScreen(state.terminal, state.serialiser);
  }

  private requireAvailable(state: ScreenState): void {
    if (state.unavailable || state.forgotten)
      throw new Error('Canonical terminal screen is unavailable after an input or restore gap');
  }

  private writeTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
    return new Promise((resolve) => terminal.write(data, resolve));
  }

  private isPersistedState(value: unknown): value is PersistedTerminalState {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<PersistedTerminalState>;
    return (
      candidate.version === 1 &&
      typeof candidate.cols === 'number' &&
      typeof candidate.rows === 'number' &&
      this.validSize(candidate.cols, candidate.rows) &&
      typeof candidate.data === 'string'
    );
  }

  private validSize(cols: number, rows: number): boolean {
    return (
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols > 0 &&
      rows > 0 &&
      cols <= 1000 &&
      rows <= 1000
    );
  }

  private isMissing(error: unknown): boolean {
    return (
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    );
  }

  private file(stream: string, term: string): string | null {
    return this.stateDir ? join(this.stateDir, stream, `${term}${STATE_SUFFIX}`) : null;
  }

  private key(stream: string, term: string): string {
    return `${stream} ${term}`;
  }

  private split(key: string): [string, string] {
    const separator = key.indexOf(' ');
    return [key.slice(0, separator), key.slice(separator + 1)];
  }
}
