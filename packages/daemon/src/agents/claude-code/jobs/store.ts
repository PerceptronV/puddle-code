import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AgentLaunchError } from '../../launch-error.js';

const exec = promisify(execFile);
const ref = z.string().uuid();
const recordSchema = z.object({
  sessionId: ref,
  forkParentSessionId: ref.nullable().optional(),
  forkSessionId: ref.nullable().optional(),
  cwd: z.string().min(1).max(4096).refine(isAbsolute),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  state: z.string().max(40),
  backend: z.string().max(40),
  interactiveLineage: z.boolean().optional(),
  intent: z.string().optional(),
});

export interface ClaudeJob {
  id: string;
  ref: string;
  parentRef: string | null;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  state: string;
  backend: string;
}

/** Metadata only, never a claim that a saved native worker is still running. */
export async function claudeJobs(configDir: string): Promise<ClaudeJob[]> {
  const root = join(configDir, 'jobs');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const jobs: ClaudeJob[] = [];
  for (let offset = 0; offset < entries.length; offset += 16) {
    const page = await Promise.all(
      entries.slice(offset, offset + 16).map(async (entry) => {
        if (!entry.isDirectory() || !/^[0-9a-f]{8}$/.test(entry.name)) return null;
        let file;
        try {
          file = await open(
            join(root, entry.name, 'state.json'),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 1024 * 1024)
            throw new Error('Claude job metadata is unavailable');
          const buffer = Buffer.alloc(info.size + 1);
          let size = 0;
          while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
            if (!bytesRead) break;
            size += bytesRead;
          }
          if (size > info.size) throw new Error('Claude job metadata changed while reading');
          const data = recordSchema.parse(JSON.parse(buffer.subarray(0, size).toString('utf8')));
          return {
            id: entry.name,
            ref: data.sessionId,
            cwd: data.cwd,
            parentRef:
              data.interactiveLineage && data.forkSessionId === data.sessionId
                ? (data.forkParentSessionId ?? null)
                : null,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            title: data.intent?.trim().replace(/\s+/g, ' ').slice(0, 80) || null,
            state: data.state,
            backend: data.backend,
          } satisfies ClaudeJob;
        } finally {
          await file.close();
        }
      }),
    );
    for (const job of page) if (job) jobs.push(job);
  }
  return jobs;
}

const liveSchema = z.array(
  z.object({
    kind: z.enum(['interactive', 'background']),
    id: z.string().optional(),
    sessionId: z.string().optional(),
    pid: z.number().int().positive().nullable().optional(),
    cwd: z.string(),
    startedAt: z.number(),
    state: z.string().optional(),
  }),
);

export interface ObservedClaudeJob extends ClaudeJob {
  /** The supervisor keeps its launch identity after /clear changes the live conversation. */
  launchRef: string;
  pid: number | null;
  startedAt: number;
}

/** Fresh native identities, including jobs whose foreground conversation changed. */
export async function observeClaudeJobs(
  configDir: string,
  env?: Record<string, string>,
): Promise<ObservedClaudeJob[]> {
  const saved = await claudeJobs(configDir);
  if (!saved.length) return [];
  try {
    const { stdout } = await exec('claude', ['agents', '--json', '--all'], {
      env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: configDir },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    const observed = liveSchema.parse(JSON.parse(stdout));
    return saved.map((job) => {
      const matches = observed.filter(
        (entry) => entry.kind === 'background' && entry.id === job.id,
      );
      if (matches.length !== 1 || matches[0]!.cwd !== job.cwd || job.backend !== 'daemon')
        throw new Error('Native job identity could not be confirmed');
      const current = matches[0]!;
      const currentRef = ref.parse(current.sessionId);
      return {
        ...job,
        launchRef: job.ref,
        ref: currentRef,
        parentRef: currentRef === job.ref ? job.parentRef : null,
        state: current.state ?? job.state,
        pid: current.pid ?? null,
        startedAt: current.startedAt,
      };
    });
  } catch {
    throw new AgentLaunchError(
      'Cannot inspect the Claude-owned background conversation; refusing a duplicate foreground resume',
    );
  }
}

/** Unavailable evidence must never permit a duplicate foreground resume. */
export async function inspectClaudeJob(
  configDir: string,
  nativeRef: string,
  env?: Record<string, string>,
): Promise<ObservedClaudeJob | null> {
  const matches = (await observeClaudeJobs(configDir, env)).filter((job) => job.ref === nativeRef);
  if (matches.length > 1)
    throw new AgentLaunchError('Claude background conversation identity is ambiguous');
  return matches[0] ?? null;
}
