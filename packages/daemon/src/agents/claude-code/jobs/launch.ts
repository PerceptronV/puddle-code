import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LifecycleLaunchContext, LifecycleLaunchResource } from '../../adapter.js';
import { AgentLaunchError } from '../../launch-error.js';
import { interactiveResource } from '../../interactive/control.js';
import { claudeJobRequest, inspectClaudeDaemon, type ClaudeDaemon } from './control.js';
import { inspectClaudeJob, type ObservedClaudeJob } from './store.js';
import { routeClaudeJob } from './hooks.js';
import { CLAUDE_JOB_TERMINAL_SOURCE } from './terminal-source.js';

function ended(pid: number | null): boolean {
  if (pid === null) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Attach one existing native worker; never resume its transcript beside it. */
export async function prepareClaudeJob(
  context: LifecycleLaunchContext,
): Promise<LifecycleLaunchResource | null> {
  if (!context.resumeRef) return null;
  try {
    let job = await inspectClaudeJob(context.account.config_dir, context.resumeRef, context.env);
    if (!job) return null;
    const terminal = () => ['done', 'failed', 'stopped'].includes(job!.state) && ended(job!.pid);
    // A completed public native inspection with no remaining process is a
    // normal transcript resume, including when its idle supervisor has exited.
    if (terminal()) return null;
    const daemon = await inspectClaudeDaemon(context.account.config_dir, context.env);
    const id = job.id;
    const deadline = Date.now() + 3000;
    for (;;) {
      const present = await claudeJobRequest(daemon, { op: 'has', short: id });
      if (present['alive'] === true && present['ready'] === true && job.pid && !ended(job.pid))
        break;
      if (present['alive'] === false && terminal()) return null;
      if (Date.now() >= deadline) throw new Error('Native job is not ready');
      // A newly recorded fork can precede its worker. Re-observe within this
      // one launch; absence during preparation never authorises foreground resume.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const fresh = await inspectClaudeJob(
        context.account.config_dir,
        context.resumeRef,
        context.env,
      );
      if (!fresh || fresh.id !== id) throw new Error('Native job changed while preparing');
      job = fresh;
    }
    if (resolve(job.cwd) !== resolve(context.opts.worktreePath))
      throw new Error('Native job moved working directory');
    const reply = await claudeJobRequest(daemon, { op: 'list' });
    const entries = Array.isArray(reply['jobs'])
      ? reply['jobs'].filter((entry) => entry.short === job.id)
      : [];
    const worker = entries[0];
    if (
      entries.length !== 1 ||
      worker.sessionId !== job.launchRef ||
      worker.cwd !== job.cwd ||
      !Number.isInteger(worker.pid) ||
      worker.pid <= 0
    )
      throw new Error('Native worker identity is unavailable');
    // The native list reports its worker root; agents --json can report its
    // interactive child. Retain both, without equating their process identities.
    return await attachJob(context, daemon, job, worker.pid, job.pid);
  } catch (error) {
    if (error instanceof AgentLaunchError) throw error;
    throw new AgentLaunchError(
      'Cannot attach the exact Claude background worker; leaving it untouched',
      { cause: error },
    );
  }
}

async function attachJob(
  context: LifecycleLaunchContext,
  daemon: ClaudeDaemon,
  job: ObservedClaudeJob,
  pid: number,
  interactivePid: number,
): Promise<LifecycleLaunchResource> {
  if (!context.writeInput) throw new Error('Claude attachment requires an owning terminal');
  const releaseBuffers = context.bufferAllowance?.reserve(512 * 1024);
  if (context.bufferAllowance && !releaseBuffers)
    throw new Error('Claude viewer buffer allowance exhausted');
  let directory: string;
  try {
    directory = mkdtempSync(join(tmpdir(), 'puddle-cj-'));
  } catch (error) {
    releaseBuffers?.();
    throw error;
  }
  const path = join(directory, 'owner.sock');
  // Reattachment continues a live execution; it must not submit the automatic
  // interruption note intended for a newly restarted agent.
  const interactive = interactiveResource(
    { ...context, opts: { ...context.opts, prompt: undefined } },
    context.account.config_dir,
    '\x1b',
  );
  const control = interactive.control!;
  let peer: Socket | null = null,
    closed = false,
    attached = false,
    attaching = false,
    validating = false;
  let nativeRef = job.ref,
    attachId = '',
    generation = 0;
  let unroute: (() => void) | undefined;
  let resizing = false;
  let geometry: { cols: number; rows: number; attachId: string } | null = null;
  const send = (message: object) => {
    if (!peer || peer.destroyed || peer.writableLength > 64 * 1024) {
      peer?.destroy();
      return;
    }
    peer.write(JSON.stringify(message) + '\n');
  };
  const notice = () =>
    send({
      type: 'notice',
      text: 'Claude view detached. Press Enter to reattach this conversation.',
    });
  const verify = async () => {
    const reply = await claudeJobRequest(daemon, { op: 'list' });
    const jobs = reply['jobs'];
    if (!Array.isArray(jobs)) throw new Error('Native job list unavailable');
    const current = jobs.filter((entry) => entry.short === job.id);
    if (
      current.length !== 1 ||
      current[0].sessionId !== job.launchRef ||
      current[0].pid !== pid ||
      current[0].cwd !== job.cwd
    )
      throw new Error('Native worker identity changed');
  };
  const open = async () => {
    if (closed || attaching || attached) return;
    attaching = true;
    const epoch = ++generation;
    try {
      await verify();
      if (closed || generation !== epoch) return;
      attachId = randomUUID();
      send({ type: 'connect', socket: daemon.socket, auth: daemon.auth, job: job.id, attachId });
    } catch {
      if (closed || generation !== epoch) return;
      attaching = false;
      notice();
    }
  };
  const resized = async () => {
    if (resizing) return;
    resizing = true;
    try {
      while (geometry && !closed) {
        const value = geometry;
        geometry = null;
        if (!attached || value.attachId !== attachId) continue;
        await claudeJobRequest(daemon, { op: 'resize', short: job.id, ...value });
      }
    } catch {
      /* Resize cannot authorise a replacement or replay input. */
    } finally {
      resizing = false;
    }
  };
  const message = async (value: Record<string, unknown>) => {
    if (closed) return;
    if (value['type'] === 'attach') return open();
    if (value['attachId'] !== attachId) return;
    if (value['type'] === 'attached') {
      if (!attaching || attached || validating) return;
      validating = true;
      const epoch = generation;
      await verify();
      const current = await inspectClaudeJob(context.account.config_dir, nativeRef, context.env);
      if (!current || current.id !== job.id || current.pid !== interactivePid)
        throw new Error('Native conversation changed while attaching');
      if (closed || epoch !== generation) return;
      await context.bindConversation?.(nativeRef);
      if (closed || epoch !== generation) return;
      attached = true;
      attaching = false;
      // The native composer can retain a draft across viewers. Until a native
      // turn establishes a clean boundary, only human input is admissible.
      control.input?.();
      validating = false;
      send({ type: 'ready', attachId });
      context.reportStatus?.(current.state === 'blocked' ? 'waiting_input' : 'working');
    } else if (value['type'] === 'detached') {
      if (!attached && !attaching) return;
      validating = false;
      ++generation;
      attached = false;
      attaching = false;
      control.input?.(); // A detach invalidates a pending automated turn and any draft assumptions.
      const epoch = generation;
      const state = await claudeJobRequest(daemon, { op: 'has', short: job.id });
      if (closed || epoch !== generation) return;
      if (state['alive'] === false && ended(pid) && ended(interactivePid))
        send({ type: 'exit', code: 0 });
      else notice();
    } else if (value['type'] === 'resize') {
      const cols = value['cols'],
        rows = value['rows'];
      if (
        typeof cols !== 'number' ||
        typeof rows !== 'number' ||
        !Number.isInteger(cols) ||
        !Number.isInteger(rows) ||
        cols < 1 ||
        rows < 1 ||
        cols > 1000 ||
        rows > 1000
      )
        return;
      geometry = { cols, rows, attachId };
      void resized();
    }
  };
  const server = createServer((socket) => {
    let pending = '',
      authenticated = false;
    const timeout = setTimeout(() => socket.destroy(), 2000);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timeout);
      if (peer === socket) {
        peer = null;
        attached = false;
        ++generation;
      }
    });
    socket.on('data', (data: string) => {
      pending += data;
      if (Buffer.byteLength(pending) > 64 * 1024) return socket.destroy();
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        let value;
        try {
          value = JSON.parse(pending.slice(0, end));
        } catch {
          return socket.destroy();
        }
        pending = pending.slice(end + 1);
        if (!value || typeof value !== 'object') return socket.destroy();
        if (!authenticated) {
          if (peer || value.type !== 'hello' || value.nonce !== context.signalNonce)
            return socket.destroy();
          clearTimeout(timeout);
          authenticated = true;
          peer = socket;
          void open();
        } else
          void message(value).catch(() => {
            attached = false;
            attaching = false;
            context.reportLifecycleUnavailable?.();
            send({ type: 'exit', code: 1 });
          });
      }
    });
  });
  server.maxConnections = 1;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    chmodSync(path, 0o600);
    unroute = routeClaudeJob(context, job.id);
  } catch (error) {
    server.close();
    rmSync(directory, { recursive: true, force: true });
    await interactive.dispose();
    releaseBuffers?.();
    throw error;
  }
  return {
    binary: process.execPath,
    args: ['-e', CLAUDE_JOB_TERMINAL_SOURCE, path],
    sidecarPids: [...new Set([pid, interactivePid])],
    control: {
      get ready() {
        return attached && control.ready;
      },
      ask: (prompt, signal, schema) =>
        attached
          ? control.ask(prompt, signal, schema)
          : Promise.reject(new Error('Claude view is detached')),
      input: () => control.input?.(),
      signal: (event) => control.signal?.(event),
      lifecycle: (ref, stopped) => {
        if (ref && !stopped) nativeRef = ref;
        control.lifecycle?.(ref, stopped);
      },
    },
    stop: async () => {
      attached = false;
      const present = await claudeJobRequest(daemon, { op: 'has', short: job.id });
      if (present['alive'] === false && ended(pid) && ended(interactivePid)) return;
      await verify();
      const current = await inspectClaudeJob(context.account.config_dir, nativeRef, context.env);
      if (!current || current.id !== job.id || current.pid !== interactivePid)
        throw new Error('Native conversation changed before stop');
      // One native mutation only. A lost reply remains uncertain, never a retry.
      await claudeJobRequest(daemon, { op: 'kill', short: job.id });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = await claudeJobRequest(daemon, { op: 'has', short: job.id });
        if (state['alive'] === false && ended(pid) && ended(interactivePid)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Claude worker stop could not be confirmed');
    },
    dispose: async () => {
      if (closed) return;
      closed = true;
      ++generation;
      attached = false;
      unroute?.();
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
      await interactive.dispose();
      releaseBuffers?.();
    },
  };
}
