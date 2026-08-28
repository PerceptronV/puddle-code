import { isAbsolute, normalize, resolve } from 'node:path';

const MAX_DIAGNOSTICS = 100;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_NOTICE_OUTPUT_BYTES = 256 * 1024;
const SOURCE_SUFFIX = String.raw`(?:tex|bib|sty|cls|bst)`;
const FILE_LINE = new RegExp(String.raw`^(.+?\.${SOURCE_SUFFIX}):(\d+)(?::(\d+))?:\s*(.+)$`, 'i');

export interface LatexSourceDiagnostic {
  absolutePath: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
  column?: number;
}

/** A failed TeX command with bounded display output and parsed source locations. */
export class LatexBuildFailure extends Error {
  constructor(
    message: string,
    readonly output: string,
    readonly diagnostics: LatexSourceDiagnostic[],
  ) {
    super(message);
    this.name = 'LatexBuildFailure';
  }
}

/**
 * Parse the stable `-file-line-error` form first, then TeX's classic
 * `! message` + `l.<number>` pair. This intentionally stays small: providers
 * normalise diagnostics, while the complete output remains available in the
 * expandable notification for formats a local package emits differently.
 */
export function parseLatexDiagnostics(
  output: string,
  defaultSource: string,
  workingDirectory: string,
): LatexSourceDiagnostic[] {
  const diagnostics: LatexSourceDiagnostic[] = [];
  const seen = new Set<string>();
  let pendingMessage: string | null = null;

  const add = (diagnostic: LatexSourceDiagnostic): void => {
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    const message = cleanMessage(diagnostic.message);
    if (message === '') return;
    const key = `${diagnostic.absolutePath}\0${diagnostic.line}\0${diagnostic.column ?? 0}\0${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push({ ...diagnostic, message });
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const located = FILE_LINE.exec(line);
    if (located) {
      const source = located[1] ?? defaultSource;
      const lineNumber = Number.parseInt(located[2] ?? '', 10);
      const column = Number.parseInt(located[3] ?? '', 10);
      const message = located[4] ?? '';
      add({
        absolutePath: normaliseSource(source, workingDirectory),
        severity: /warning/i.test(message) ? 'warning' : 'error',
        message,
        line: lineNumber,
        ...(Number.isInteger(column) && column > 0 ? { column } : {}),
      });
      pendingMessage = null;
      continue;
    }
    if (line.startsWith('!')) {
      pendingMessage = line.slice(1).trim();
      continue;
    }
    if (pendingMessage) {
      const classic = /^l\.(\d+)\s*(.*)$/.exec(line);
      if (classic) {
        add({
          absolutePath: normalize(defaultSource),
          severity: 'error',
          message: [pendingMessage, classic[2]?.trim()].filter(Boolean).join(' — '),
          line: Number.parseInt(classic[1] ?? '', 10),
        });
        pendingMessage = null;
      }
    }
  }
  return diagnostics;
}

/** Keep notifications responsive while preserving both command context and the final error. */
export function boundedLatexOutput(output: string): string {
  const bytes = Buffer.byteLength(output);
  if (bytes <= MAX_NOTICE_OUTPUT_BYTES) return output.trim();
  const head = output.slice(0, 32 * 1024);
  const tail = output.slice(-(MAX_NOTICE_OUTPUT_BYTES - 32 * 1024));
  return `${head.trimEnd()}\n\n… ${bytes - MAX_NOTICE_OUTPUT_BYTES} output bytes omitted …\n\n${tail.trimStart()}`;
}

function normaliseSource(path: string, workingDirectory: string): string {
  const unquoted = stripQuotes(path.trim());
  return normalize(isAbsolute(unquoted) ? unquoted : resolve(workingDirectory, unquoted));
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function cleanMessage(message: string): string {
  return message.replace(/^!\s*/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH);
}
