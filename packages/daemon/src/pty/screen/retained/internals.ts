import type { Terminal } from '@xterm/headless';

export interface Line {
  _data: Uint32Array;
  _combined: Record<string, string>;
  _extendedAttrs: Record<string, unknown>;
  getString(column: number): string;
  getWidth(column: number): number;
}
export interface Marker {
  line: number;
  dispose(): void;
}
export interface BufferState {
  x: number;
  y: number;
  ybase: number;
  scrollTop: number;
  scrollBottom: number;
  savedX: number;
  lines: {
    length: number;
    readonly isFull: boolean;
    _array: Array<Line | undefined>;
    get(index: number): Line | undefined;
  };
  markers: Marker[];
  _memoryCleanupQueue: { clear(): void };
}
export interface LinkEntry {
  id: number;
  data: { id?: string; uri: string };
  key?: string;
  lines: Marker[];
}
export interface Parameters {
  params: ArrayLike<number>;
}
export interface SequenceParser {
  _active: unknown[];
  put(data: Uint32Array, start: number, end: number): void;
}
export interface InputHandler {
  parse(data: string | Uint8Array, result?: boolean): void | Promise<boolean>;
  print(data: Uint32Array, start: number, end: number): void;
  repeatPrecedingCharacter(params: Parameters): boolean;
  setTitle(value: string): boolean;
  setIconName(value: string): boolean;
  _activeBuffer: BufferState;
  _charsetService: { charset: Record<string, string> | undefined };
  _unicodeService: { charProperties(code: number, preceding: number): number };
  _parser: {
    precedingJoinState: number;
    _oscParser: SequenceParser & { start(): void; _put: SequenceParser['put'] };
    _dcsParser: SequenceParser & { hook(...args: unknown[]): void };
  };
}
export interface Core {
  _inputHandler: InputHandler;
  _bufferService: {
    scroll(attributes: unknown, isWrapped?: boolean): void;
    buffers: { normal: BufferState; alt: BufferState; active: BufferState; reset(): void };
  };
  _oscLinkService: {
    _dataByLinkId: Map<number, LinkEntry>;
    _entriesWithId: Map<string, LinkEntry>;
    registerLink(data: LinkEntry['data']): number;
    addLineToLink(id: number, line: number): void;
  };
}

export function coreOf(terminal: Terminal): Core {
  const core = (terminal as unknown as { _core?: Core })._core;
  const input = core?._inputHandler;
  const buffers = core?._bufferService?.buffers;
  if (
    !core ||
    !input ||
    !buffers ||
    typeof core._bufferService.scroll !== 'function' ||
    typeof input.print !== 'function' ||
    typeof input.parse !== 'function' ||
    typeof input.repeatPrecedingCharacter !== 'function' ||
    typeof input.setTitle !== 'function' ||
    typeof input.setIconName !== 'function' ||
    typeof input._unicodeService?.charProperties !== 'function' ||
    typeof input._parser?._oscParser?.start !== 'function' ||
    typeof input._parser?._oscParser?.put !== 'function' ||
    typeof input._parser?._oscParser?._put !== 'function' ||
    !Array.isArray(input._parser?._oscParser?._active) ||
    typeof input._parser?._dcsParser?.hook !== 'function' ||
    typeof input._parser?._dcsParser?.put !== 'function' ||
    !Array.isArray(input._parser?._dcsParser?._active) ||
    !(core._oscLinkService?._dataByLinkId instanceof Map) ||
    !(core._oscLinkService?._entriesWithId instanceof Map) ||
    typeof core._oscLinkService.registerLink !== 'function' ||
    typeof core._oscLinkService.addLineToLink !== 'function' ||
    typeof buffers.reset !== 'function' ||
    [buffers.normal, buffers.alt].some(
      (buffer) =>
        !buffer ||
        typeof buffer.lines?.get !== 'function' ||
        typeof buffer.lines.isFull !== 'boolean' ||
        !Number.isInteger(buffer.scrollTop) ||
        !Number.isInteger(buffer.scrollBottom) ||
        !Number.isInteger(buffer.savedX) ||
        !Array.isArray(buffer.lines._array) ||
        !Array.isArray(buffer.markers) ||
        typeof buffer._memoryCleanupQueue?.clear !== 'function',
    )
  )
    throw new Error('Retained terminal internals do not match pinned xterm 6.0.0');
  return core;
}
