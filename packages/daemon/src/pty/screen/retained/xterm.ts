import type { Terminal } from '@xterm/headless';
import type { ScreenRetainedLease } from './budget.js';
import { coreOf, type Core, type BufferState, type SequenceParser } from './internals.js';
import { guardGeometryGrowth, setHistoryCapacity } from './geometry.js';

/**
 * Instance-only guards for the exact-pinned headless emulator. Ordinary runs stay
 * on upstream print; only joining Unicode needs a cell-level admission check.
 * Never throw from a parser callback: xterm would strand its write callback.
 */
export class XtermRetainedState {
  private readonly core: Core;
  private failure: Error | null = null;
  private disposed = false;
  private expansion = 0;
  private activeWrite = false;

  constructor(
    readonly terminal: Terminal,
    readonly lease: ScreenRetainedLease,
    private readonly unavailable: (error: Error) => void,
  ) {
    this.core = coreOf(terminal);
    lease.attach((scrollback) => setHistoryCapacity(terminal, this.core, scrollback));
    setHistoryCapacity(terminal, this.core, lease.scrollback);
    this.guardPrint();
    this.guardRepeat();
    this.guardSequences();
    this.guardLinks();
    this.guardTitles();
    guardGeometryGrowth(
      this.core,
      lease,
      () => this.failure !== null,
      (message) => this.fail(message),
    );
    const input = this.core._inputHandler;
    const parse = input.parse.bind(input);
    input.parse = (data, result) => (this.failure ? undefined : parse(data, result));
    const buffers = this.core._bufferService.buffers;
    const reset = buffers.reset.bind(buffers);
    buffers.reset = () => {
      // Buffer children and their idle cleanup queues are not disposed by xterm.
      this.clearBuffers();
      reset();
      // Reset positively replaced the old buffers after cancelling their idle
      // tasks/markers. The new viewport needs no prepaid historical rows.
      lease.trim(0);
    };
  }

  get error(): Error | null {
    return this.failure;
  }

  private fail(message: string): void {
    if (this.failure) return;
    this.failure = new Error(message);
    this.unavailable(this.failure);
  }

  private charge(bytes: number): boolean {
    if (this.failure) return false;
    if (this.lease.charge(bytes, () => this.inspectVariables())) return true;
    this.fail('Canonical terminal retained text capacity exhausted');
    return false;
  }

  private guardPrint(): void {
    const input = this.core._inputHandler;
    const original = input.print.bind(input);
    input.print = (data, start, end) => {
      if (this.failure) return;
      let run = start;
      for (let pos = start; pos < end; pos++) {
        // ASCII cannot join under the pinned default Unicode provider. Charset
        // replacement remains upstream; its built-in mappings are single cells.
        if (data[pos]! < 127) continue;
        if (run < pos) original(data, run, pos);
        if (this.failure) return;
        const info = input._unicodeService.charProperties(
          data[pos]!,
          input._parser.precedingJoinState,
        );
        if ((info & 1) !== 0) {
          const buffer = input._activeBuffer;
          const row = buffer.lines.get(buffer.ybase + buffer.y);
          const offset = row?.getWidth(buffer.x - 1) ? 1 : 2;
          const previous = buffer.x > 0 ? (row?.getString(buffer.x - offset) ?? '') : '';
          const units = previous.length + (data[pos]! > 0xffff ? 2 : 1);
          if (units > this.lease.owner.limits.combinedUnits) {
            this.fail('Canonical terminal combined character exceeds retained capacity');
            return;
          }
          // Charge the whole new immutable string: copies elsewhere may retain
          // the old one. A pressure-only sweep releases overwritten/scrolled data.
          if (!this.charge(units * 2 + 128)) return;
        }
        original(data, pos, pos + 1);
        run = pos + 1;
      }
      if (!this.failure && run < end) original(data, run, end);
    };
  }

  private guardRepeat(): void {
    const input = this.core._inputHandler;
    const original = input.repeatPrecedingCharacter.bind(input);
    input.repeatPrecedingCharacter = (params) => {
      if (this.failure) return true;
      const width = (input._parser.precedingJoinState >> 1) & 3;
      const buffer = input._activeBuffer;
      const text = buffer.lines.get(buffer.ybase + buffer.y)?.getString(buffer.x - width) ?? '';
      // Upstream allocates UTF32 using UTF16 length, before calling print.
      const bytes = text.length * (params.params[0] || 1) * 4;
      if (
        !this.activeWrite ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > this.lease.owner.limits.burstBytes - this.expansion
      ) {
        this.fail('Canonical terminal repeat exceeds parser burst capacity');
        return true;
      }
      this.expansion += bytes;
      return original(params);
    };
  }

  private guardSequences(): void {
    const { _oscParser: osc, _dcsParser: dcs } = this.core._inputHandler._parser;
    const guard = (original: SequenceParser['put'], active: () => number) => {
      let units = 0;
      const put: SequenceParser['put'] = (data, start, end) => {
        if (this.failure) return;
        // Unknown sequences have no collector: retaining their payload is not
        // necessary to preserve the canonical screen, and upstream ignores it.
        if (active() === 0) return original(data, start, end);
        // UTF32 to UTF16 conversion can contribute two code units per item.
        units += 2 * (end - start) * active();
        if (units > this.lease.owner.limits.sequenceUnits) {
          this.fail('Canonical terminal control sequence exceeds retained capacity');
          return;
        }
        original(data, start, end);
      };
      return {
        put,
        reset: () => {
          units = 0;
        },
      };
    };
    // _put runs after the OSC identifier selected its collectors, including
    // when the identifier and its first payload arrive in the same chunk.
    const oscGuard = guard(osc._put.bind(osc), () => osc._active.length);
    const start = osc.start.bind(osc);
    osc._put = oscGuard.put;
    osc.start = () => {
      oscGuard.reset();
      start();
    };
    const hook = dcs.hook.bind(dcs);
    const dcsGuard = guard(dcs.put.bind(dcs), () => dcs._active.length);
    dcs.put = dcsGuard.put;
    dcs.hook = (...args) => {
      dcsGuard.reset();
      hook(...args);
    };
  }

  private guardTitles(): void {
    const input = this.core._inputHandler;
    for (const name of ['setTitle', 'setIconName'] as const) {
      const original = input[name].bind(input);
      input[name] = (value) => {
        if (this.failure) return true;
        if (value.length > this.lease.owner.limits.titleUnits) {
          this.fail('Canonical terminal title exceeds retained capacity');
          return true;
        }
        return original(value);
      };
    }
  }

  private guardLinks(): void {
    const service = this.core._oscLinkService;
    const register = service.registerLink.bind(service);
    const add = service.addLineToLink.bind(service);
    service.registerLink = (data) => {
      if (this.failure) return 0;
      const units = data.uri.length + (data.id?.length ?? 0);
      // Reusing an exact link allocates no new strings/entry. The separately
      // guarded addLineToLink still admits any newly retained marker.
      if (data.id !== undefined && service._entriesWithId.has(`${data.id};;${data.uri}`))
        return register(data);
      if (
        units > this.lease.owner.limits.linkUnits ||
        service._dataByLinkId.size >= this.lease.owner.limits.links ||
        this.markerCount() >= this.lease.owner.limits.markers
      ) {
        this.fail('Canonical terminal hyperlink exceeds retained capacity');
        return 0;
      }
      // URI/id plus the keyed lookup string and entry/initial marker metadata.
      if (!this.charge(4 * units + 512)) return 0;
      return register(data);
    };
    service.addLineToLink = (id, line) => {
      if (this.failure) return;
      const entry = service._dataByLinkId.get(id);
      if (entry && !entry.lines.some((marker) => marker.line === line)) {
        if (this.markerCount() >= this.lease.owner.limits.markers) {
          this.fail('Canonical terminal hyperlink marker capacity exhausted');
          return;
        }
        if (!this.charge(256)) return;
      }
      add(id, line);
    };
  }

  private markerCount(): number {
    let count = 0;
    for (const entry of this.core._oscLinkService._dataByLinkId.values())
      count += entry.lines.length;
    return count;
  }

  /** Only on variable-capacity pressure; ordinary ASCII never scans old rows. */
  private inspectVariables(): number {
    const maximum = this.lease.owner.limits.variableBytes;
    let bytes = 0;
    for (const buffer of this.buffers()) {
      for (const line of buffer.lines._array) {
        if (!line) continue;
        if (
          !line ||
          !(line._data instanceof Uint32Array) ||
          !line._combined ||
          !line._extendedAttrs
        )
          return maximum + 1;
        // Overwriting a cell does not remove stale combined entries in xterm.
        for (const key in line._combined) {
          bytes += 128 + 2 * line._combined[key]!.length;
          if (bytes > maximum) return bytes;
        }
      }
    }
    for (const entry of this.core._oscLinkService._dataByLinkId.values()) {
      bytes +=
        256 +
        2 * (entry.data.uri.length + (entry.data.id?.length ?? 0) + (entry.key?.length ?? 0)) +
        256 * entry.lines.length;
      if (bytes > maximum) return bytes;
    }
    return bytes;
  }

  async write(data: string): Promise<void> {
    if (this.disposed || this.failure)
      throw this.failure ?? new Error('Canonical terminal disposed');
    for (let start = 0; start < data.length;) {
      const release = await this.lease.owner.acquireBurst(this.lease.owner.limits.burstBytes);
      try {
        if (this.disposed || this.failure)
          throw this.failure ?? new Error('Canonical terminal disposed');
        // Feed a bounded batch through xterm's existing async write loop. It
        // still decodes small chunks without a timer turn for every chunk.
        // Admit before taking substring copies or adding write callbacks.
        const chunks: string[] = [];
        let copiedBytes = 0;
        while (start < data.length && chunks.length < 16) {
          let end = Math.min(data.length, start + this.lease.owner.limits.writeUnits);
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
          const bytes = 2 * (end - start);
          if (copiedBytes + bytes > this.lease.owner.limits.burstBytes) {
            if (chunks.length) break;
            throw new Error('Canonical terminal input exceeds parser burst capacity');
          }
          chunks.push(data.slice(start, end));
          copiedBytes += bytes;
          start = end;
        }
        this.expansion = copiedBytes;
        this.activeWrite = true;
        await new Promise<void>((resolve) => {
          let remaining = chunks.length;
          for (const chunk of chunks)
            this.terminal.write(chunk, () => {
              if (--remaining === 0) resolve();
            });
        });
      } finally {
        this.activeWrite = false;
        release();
      }
      if (this.failure) throw this.failure;
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.disposed || this.failure)
      throw this.failure ?? new Error('Canonical terminal disposed');
    const release = await this.lease.owner.acquireBurst(this.lease.owner.limits.burstBytes);
    try {
      this.lease.owner.rebalance(this.lease, cols, rows);
      const oldCols = this.terminal.cols;
      const normal = this.core._bufferService.buffers.normal;
      const estimate = () => {
        const lines =
          normal.lines.length + this.core._bufferService.buffers.alt.lines.length + 2 * rows;
        // Smaller reflow allocates wrapped rows at OLD width before truncation.
        const amplification = cols < oldCols ? Math.ceil(oldCols / cols) + 1 : 1;
        return (
          lines *
          amplification *
          (Math.max(cols, oldCols) * this.lease.owner.limits.cellBytes +
            this.lease.owner.limits.lineBytes)
        );
      };
      if (estimate() > this.lease.owner.limits.burstBytes) {
        this.lease.trim(0);
        if (estimate() > this.lease.owner.limits.burstBytes)
          throw new Error('Canonical terminal resize exceeds reflow burst capacity');
      }
      this.terminal.resize(cols, rows);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Canonical terminal resize failed');
      throw this.failure;
    } finally {
      release();
    }
  }

  private buffers(): BufferState[] {
    const buffers = this.core._bufferService.buffers;
    return [buffers.normal, buffers.alt];
  }
  private clearBuffers(): void {
    for (const buffer of this.buffers()) {
      buffer._memoryCleanupQueue.clear();
      for (const marker of [...buffer.markers]) marker.dispose();
    }
  }
  /** The caller waits for the actual write callback before releasing retained credit. */
  dispose(): void {
    if (this.disposed) return;
    if (this.activeWrite) throw new Error('Cannot dispose canonical terminal during parser work');
    this.disposed = true;
    this.clearBuffers();
    this.terminal.dispose();
    this.lease.dispose();
  }
}
