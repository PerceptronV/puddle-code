import { open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { AgentUsage } from '../adapter.js';
import { transcriptFiles } from './transcript-files.js';
import { addUsage, emptyUsage, recordUsage, UsageRecord } from './usage-record.js';

const CHUNK_BYTES = 64 * 1024;
const CACHE_ACCOUNTS = 16;
const CACHE_FILES = 4096;
const fingerprint = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const caches = new Map<string, Map<string, { fingerprint: string; usage: AgentUsage }>>();
const active = new Map<string, Promise<AgentUsage | null>>();

/** Coalesce concurrent account reads. No append-only assumption or transcript retention. */
export function claudeUsage(configDir: string): Promise<AgentUsage | null> {
  const pending = active.get(configDir);
  if (pending) return pending;
  const scan = scanUsage(configDir).finally(() => active.delete(configDir));
  active.set(configDir, scan);
  return scan;
}

async function scanUsage(configDir: string): Promise<AgentUsage | null> {
  const cache = caches.get(configDir) ?? new Map();
  caches.delete(configDir);
  caches.set(configDir, cache);
  while (caches.size > CACHE_ACCOUNTS) caches.delete(caches.keys().next().value!);
  const live = new Set<string>();
  const total = emptyUsage();
  for await (const path of transcriptFiles(configDir)) {
    live.add(path);
    const file = await open(path, 'r').catch(() => null);
    if (!file) {
      cache.delete(path);
      continue;
    }
    try {
      const before = await file.stat();
      if (!before.isFile()) continue;
      const key = fingerprint(before);
      const cached = cache.get(path);
      if (cached?.fingerprint === key) {
        addUsage(total, cached.usage);
        continue;
      }
      const usage = await readUsage(file, before.size);
      addUsage(total, usage);
      const current = await stat(path).catch(() => null);
      // A writer can append/replace/truncate during a read. Never cache the
      // partial observation as the new file, including same-size replacements.
      if (current && fingerprint(current) === key && fingerprint(await file.stat()) === key) {
        cache.delete(path);
        cache.set(path, { fingerprint: key, usage });
        while (cache.size > CACHE_FILES) cache.delete(cache.keys().next().value!);
      } else cache.delete(path);
    } catch {
      cache.delete(path);
    } finally {
      await file.close();
    }
  }
  for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
  if (!cache.size) caches.delete(configDir);
  return live.size ? total : null;
}

/** One fixed-size read at a time; growing writers cannot extend this observation. */
async function readUsage(
  file: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<AgentUsage> {
  const total = emptyUsage();
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let small = '',
    large: UsageRecord | undefined;
  const consume = async (piece: string, end: boolean) => {
    if (!large && small.length + piece.length <= CHUNK_BYTES) small += piece;
    else {
      if (!large) {
        large = new UsageRecord();
        await large.write(small);
        small = '';
      }
      await large.write(piece);
    }
    if (!end) return;
    if (large) {
      addUsage(total, await large.finish());
      large.dispose();
      large = undefined;
    } else {
      try {
        addUsage(total, recordUsage(JSON.parse(small)));
      } catch {
        /* Partial/malformed native JSONL records do not hide later rows. */
      }
    }
    small = '';
  };
  try {
    for (let position = 0; position < size;) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (!bytesRead) break;
      position += bytesRead;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      let start = 0,
        end: number;
      while ((end = text.indexOf('\n', start)) >= 0) {
        await consume(text.slice(start, end), true);
        start = end + 1;
      }
      await consume(text.slice(start), false);
    }
    await consume(decoder.end(), true);
    return total;
  } finally {
    large?.dispose();
  }
}
