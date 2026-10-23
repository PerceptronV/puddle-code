import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  notebookKernelSpecSchema,
  type CompilationFileTarget,
  type NotebookKernelAction,
  type NotebookKernelsResponse,
  type NotebookKernelStatus,
  type NotebookEnvironment,
  type NotebookEnvironmentsResponse,
} from '@puddle/shared';
import { KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';
import { containedPath, resolveFsRoot, type WorktreeDeps } from '../http/routes/worktree-shared.js';
import { findCodeExecutable } from '../code/discovery.js';
import { NOTEBOOK_BRIDGE } from './bridge.js';
import { NotebookEnvironments } from './environments.js';

const messageSchema = z.object({
  event: z.enum(['catalogue', 'spawned', 'ready', 'stopped', 'dead']).optional(),
  id: z.number().int().optional(),
  ok: z.boolean().optional(),
  error: z.string().optional(),
  kernel: z.string().optional(),
  pid: z.number().int().positive().optional(),
  kernels: z.array(notebookKernelSpecSchema).optional(),
});

interface KernelEntry {
  source: string;
  executable: string;
  bridge: KernelBridge | null;
  selected: string | null;
  status: NotebookKernelStatus;
  busy: boolean;
  cancelled: boolean;
  changing: boolean;
  finished: Promise<void> | null;
  environment?: NotebookEnvironment;
}

/** Canonical files own their kernels until explicit shutdown or daemon disposal. */
export class NotebookKernels {
  private readonly lifecycle = new KeyedMutex();
  private readonly entries = new Map<string, KernelEntry>();
  private catalogueCache: { at: number; value: NotebookKernelsResponse } | null = null;
  private catalogueBridge: KernelBridge | null = null;
  private cataloguePending: Promise<NotebookKernelsResponse> | null = null;
  private disposed = false;

  constructor(
    private readonly deps: WorktreeDeps,
    private readonly pythonEnvironments = new NotebookEnvironments(),
  ) {}

  async environments(source: CompilationFileTarget): Promise<NotebookEnvironmentsResponse> {
    const path = await this.path(source);
    const root = await realpath(resolveFsRoot(this.deps, source.session, source.root));
    const environments = await this.pythonEnvironments.discover(path, root);
    const selected = this.entries.get(path)?.environment;
    if (selected && !environments.some((environment) => environment.python === selected.python))
      environments.unshift(await this.pythonEnvironments.inspect(selected.python));
    return { environments };
  }

  async catalogue(): Promise<NotebookKernelsResponse> {
    if (this.disposed)
      return { available: false, kernels: [], error: 'Notebook kernels are closed' };
    if (this.catalogueCache && Date.now() - this.catalogueCache.at < 30_000)
      return this.catalogueCache.value;
    if (this.cataloguePending) return this.cataloguePending;
    this.cataloguePending = (async () => {
      const executable = findCodeExecutable(['jupyter-nbconvert']);
      if (!executable) return { available: false, kernels: [] };
      let bridge: KernelBridge | null = null;
      try {
        const python = await pythonFor(executable);
        if (this.disposed) throw new Error('Notebook kernels are closed');
        bridge = new KernelBridge(python);
        this.catalogueBridge = bridge;
        return { available: true, kernels: await bridge.ready };
      } catch (error) {
        return { available: false, kernels: [], error: errorMessage(error) };
      } finally {
        await bridge?.close();
        if (this.catalogueBridge === bridge) this.catalogueBridge = null;
      }
    })()
      .then((value) => {
        this.catalogueCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.cataloguePending = null;
      });
    return this.cataloguePending;
  }

  async status(source: CompilationFileTarget): Promise<NotebookKernelStatus> {
    const path = await this.path(source);
    const entry = this.entries.get(path);
    return entry
      ? { ...entry.status, ...(entry.environment ? { environment: entry.environment } : {}) }
      : { state: 'stopped', kernel: null };
  }

  async action(request: NotebookKernelAction): Promise<NotebookKernelStatus> {
    const path = await this.path(request.source);
    return this.lifecycle.run(path, async () => {
      try {
        const status = await this.changeKernel(path, request);
        const environment = this.entries.get(path)?.environment;
        return { ...status, ...(environment ? { environment } : {}) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        const failure = new ApiError(422, 'notebook_kernel_failed', errorMessage(error));
        failure.cause = error;
        throw failure;
      }
    });
  }

  private async changeKernel(
    path: string,
    request: NotebookKernelAction,
  ): Promise<NotebookKernelStatus> {
    if (this.disposed) throw new Error('Notebook kernels are closed');
    let entry = this.entries.get(path);
    if (
      request.action === 'select-python' ||
      request.action === 'install-python' ||
      (request.action === 'restart' && entry?.environment)
    ) {
      if (request.action === 'install-python' && request.python !== entry?.environment?.python)
        throw ApiError.conflict(
          'notebook_environment_changed',
          'The selected environment changed. Select it again before installing packages.',
        );
      const python =
        request.action === 'select-python'
          ? await this.pythonEnvironments.resolvePython(request.python, dirname(path))
          : entry?.environment?.python;
      if (!python)
        throw ApiError.badRequest(
          'notebook_environment_missing',
          'Select a Python environment first',
        );
      const environment = await this.pythonEnvironments.inspect(python, true);
      if (environment.error)
        throw ApiError.badRequest('invalid_python_environment', environment.error);
      if (this.disposed) throw new Error('Notebook kernels are closed');
      entry = this.entry(path, python);
      entry.changing = true;
      try {
        await this.stop(entry);
        if (this.disposed) throw new Error('Notebook kernels are closed');
        entry.bridge = null;
        entry.environment = environment;
        entry.selected = 'python3';
        entry.status = { state: 'stopped', kernel: 'python3' };
        if (request.action === 'install-python')
          entry.environment = await this.pythonEnvironments.install(python);
        if (!entry.environment.ipykernel || !entry.environment.nbconvert) return entry.status;
        entry.status = { state: 'starting', kernel: 'python3' };
        const bridge = await this.connect(entry);
        await bridge.request({ op: 'start', kernel: 'python3', cwd: dirname(path) }, 45_000);
        entry.status = { state: 'idle', kernel: 'python3' };
      } catch (error) {
        await this.stop(entry);
        entry.bridge = null;
        entry.status = { state: 'dead', kernel: 'python3', error: errorMessage(error) };
        throw error;
      } finally {
        entry.changing = false;
      }
      return entry.status;
    }
    if (request.action === 'interrupt') {
      if (entry) entry.cancelled = true;
      if (entry?.bridge) await entry.bridge.request({ op: 'interrupt' }, 10_000);
    } else if (request.action === 'shutdown') {
      if (entry) {
        entry.changing = true;
        await this.stop(entry);
      }
      if (entry) {
        entry.bridge = null;
        entry.changing = false;
        entry.status = { state: 'stopped', kernel: entry.selected ?? entry.status.kernel };
      }
    } else {
      const catalogue = await this.catalogue();
      const name =
        request.action === 'select' ? request.kernel : (entry?.selected ?? entry?.status.kernel);
      if (name && !catalogue.kernels.some((kernel) => kernel.name === name))
        throw ApiError.badRequest(
          'notebook_kernel_missing',
          `Kernel ${name} is not installed on this host`,
        );
      const selected = name ?? catalogue.kernels[0]?.name;
      if (!selected)
        throw new ApiError(
          424,
          'notebook_kernel_missing',
          'No Jupyter kernel is installed on this host',
        );
      entry = this.entry(
        path,
        entry?.executable ?? findCodeExecutable(['jupyter-nbconvert']) ?? 'jupyter-nbconvert',
      );
      entry.changing = true;
      await this.stop(entry);
      entry.bridge = null;
      if (request.action === 'select') {
        entry.environment = undefined;
        entry.executable = findCodeExecutable(['jupyter-nbconvert']) ?? 'jupyter-nbconvert';
      }
      entry.selected = selected;
      entry.status = { state: 'starting', kernel: selected };
      try {
        const bridge = await this.connect(entry);
        await bridge.request({ op: 'start', kernel: selected, cwd: dirname(path) }, 45_000);
        entry.status = { state: 'idle', kernel: selected };
      } catch (error) {
        await this.stop(entry);
        entry.status = { state: 'dead', kernel: selected, error: errorMessage(error) };
        throw error;
      } finally {
        entry.changing = false;
      }
    }
    return entry?.status ?? { state: 'stopped', kernel: null };
  }

  async execute(
    source: string,
    output: string,
    command: { file: string; args: string[] },
  ): Promise<void> {
    if (this.disposed) throw new Error('Notebook kernels are closed');
    // Notebook commands configure nbconvert's execution options. Arbitrary
    // scripts cannot participate in Jupyter's persistent-kernel lifecycle.
    const name = basename(command.file);
    const args = name.startsWith('jupyter-nbconvert')
      ? command.args
      : name === 'jupyter' && command.args[0] === 'nbconvert'
        ? command.args.slice(1)
        : name.startsWith('python') && command.args[0] === '-m' && command.args[1] === 'nbconvert'
          ? command.args.slice(2)
          : null;
    if (!args)
      throw ApiError.badRequest(
        'invalid_notebook_command',
        'Use jupyter-nbconvert, jupyter nbconvert or python -m nbconvert for notebook execution.',
      );
    const file =
      !isAbsolute(command.file) && command.file.includes('/')
        ? resolve(dirname(source), command.file)
        : command.file;
    const canonical = await realpath(source);
    if (this.disposed) throw new Error('Notebook kernels are closed');
    const entry = this.entry(canonical, file);
    if (entry.busy || entry.changing)
      throw ApiError.conflict('notebook_busy', 'This notebook is already running');
    if (entry.status.state === 'dead')
      throw ApiError.conflict(
        'notebook_kernel_dead',
        'The notebook kernel exited. Restart it before running again.',
      );
    if (!entry.environment && entry.bridge && entry.executable !== file)
      throw ApiError.conflict(
        'notebook_environment_changed',
        'Shut down this kernel before changing the notebook executable',
      );
    if (entry.environment && (!entry.environment.ipykernel || !entry.environment.nbconvert))
      throw ApiError.conflict(
        'notebook_packages_missing',
        'Install the missing packages for the selected Python environment before running',
      );
    if (!entry.environment) entry.executable = file;
    entry.busy = true;
    entry.cancelled = false;
    let finish!: () => void;
    entry.finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    entry.status = {
      state: entry.bridge ? 'busy' : 'starting',
      kernel: entry.selected ?? entry.status.kernel,
    };
    let bridge: KernelBridge | null = null;
    try {
      bridge = await this.connect(entry);
      if (entry.cancelled || this.disposed) throw new Error('Notebook execution interrupted');
      entry.status = { ...entry.status, state: 'busy' };
      await bridge.request({
        op: 'run',
        source,
        cwd: dirname(canonical),
        output,
        args,
        kernel: entry.selected,
      });
    } catch (error) {
      entry.status = { ...entry.status, error: errorMessage(error) };
      throw error;
    } finally {
      entry.busy = false;
      if (entry.bridge === bridge && bridge && !bridge.closed && entry.status.state !== 'dead')
        entry.status = { ...entry.status, state: 'idle' };
      finish();
      entry.finished = null;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.catalogueBridge?.close();
    await this.cataloguePending;
    await Promise.all([...this.entries.values()].map((entry) => this.stop(entry)));
    this.entries.clear();
  }

  private async stop(entry: KernelEntry): Promise<void> {
    entry.cancelled = true;
    if (entry.bridge) await entry.bridge.close();
    await entry.finished;
    // Discovery may have completed after shutdown was requested.
    if (entry.bridge) await entry.bridge.close();
  }

  private entry(source: string, executable: string): KernelEntry {
    let entry = this.entries.get(source);
    if (!entry) {
      if (this.entries.size >= 256) {
        const retired = [...this.entries].find(
          ([, item]) => !item.bridge && !item.busy && !item.changing,
        );
        if (retired) this.entries.delete(retired[0]);
      }
      if ([...this.entries.values()].filter((entry) => entry.bridge !== null).length >= 32)
        throw ApiError.conflict(
          'notebook_kernel_limit',
          'Shut down a notebook kernel before opening another (32 maximum)',
        );
      entry = {
        source,
        executable,
        bridge: null,
        selected: null,
        status: { state: 'stopped', kernel: null },
        busy: false,
        changing: false,
        cancelled: false,
        finished: null,
      };
      this.entries.set(source, entry);
    }
    return entry;
  }

  private async connect(entry: KernelEntry): Promise<KernelBridge> {
    if (this.disposed) throw new Error('Notebook kernels are closed');
    if (entry.bridge) return entry.bridge;
    if (
      [...this.entries.values()].filter(
        (other) => other !== entry && (other.bridge || other.busy || other.changing),
      ).length >= 32
    )
      throw ApiError.conflict(
        'notebook_kernel_limit',
        'Shut down a notebook kernel before opening another (32 maximum)',
      );
    const bridge = new KernelBridge(
      entry.environment?.python ?? (await pythonFor(entry.executable)),
      (message) => {
        if (entry.bridge !== bridge) return;
        if (message.event === 'dead')
          entry.status = { state: 'dead', kernel: entry.status.kernel, error: message.error };
        if (message.event === 'ready')
          entry.status = { state: entry.busy ? 'busy' : 'idle', kernel: message.kernel ?? null };
      },
      (error) => {
        if (entry.bridge === bridge)
          entry.status = { state: 'dead', kernel: entry.status.kernel, error: errorMessage(error) };
      },
      !!entry.environment,
    );
    entry.bridge = bridge;
    await bridge.ready;
    if (this.disposed) {
      await bridge.close();
      throw new Error('Notebook kernels are closed');
    }
    return bridge;
  }

  private async path(source: CompilationFileTarget): Promise<string> {
    const root = resolveFsRoot(this.deps, source.session, source.root);
    const path = containedPath(root, source.path);
    if (!source.path.toLowerCase().endsWith('.ipynb') || !(await stat(path)).isFile())
      throw ApiError.badRequest('invalid_notebook', 'Choose a notebook file');
    return realpath(path);
  }
}

/** Prefer the environment that installed nbconvert, instead of another PATH Python. */
async function pythonFor(executable: string): Promise<string> {
  const resolved = isAbsolute(executable) ? executable : findCodeExecutable([executable]);
  if (!resolved) throw new Error(`${executable} is not installed on this host`);
  if (basename(resolved).startsWith('python')) return resolved;
  const handle = await open(resolved, 'r');
  let header: string;
  try {
    const bytes = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    header = bytes.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
  } finally {
    await handle.close();
  }
  const shebang = /^#!\s*(\S+)/.exec(header)?.[1];
  if (shebang && isAbsolute(shebang) && basename(shebang).startsWith('python')) return shebang;
  const python = findCodeExecutable(['python3', 'python']);
  if (!python) throw new Error('Python with Jupyter packages is not installed on this host');
  return python;
}

class KernelBridge {
  readonly ready: Promise<z.infer<typeof notebookKernelSpecSchema>[]>;
  readonly child: ChildProcessWithoutNullStreams;
  closed = false;
  private pid: number | null = null;
  private sequence = 0;
  private buffer = '';
  private stderr = '';
  private readonly pending = new Map<
    number,
    { resolve(): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }
  >();
  private closePromise: Promise<void> | null = null;

  constructor(
    python: string,
    onMessage?: (message: z.infer<typeof messageSchema>) => void,
    onExit?: (error: string) => void,
    exactPython = false,
  ) {
    this.child = spawn(
      python,
      ['-u', '-c', NOTEBOOK_BRIDGE, ...(exactPython ? ['--puddle-python'] : [])],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const child = this.child;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Jupyter discovery timed out'));
        void this.close();
      }, 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        if (this.buffer.length > 256 * 1024) {
          reject(new Error('Invalid kernel bridge output'));
          void this.close();
          return;
        }
        for (;;) {
          const end = this.buffer.indexOf('\n');
          if (end < 0) break;
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          try {
            const message = messageSchema.parse(JSON.parse(line));
            if (message.event === 'catalogue') {
              clearTimeout(timer);
              resolve(message.kernels ?? []);
            }
            if (message.event === 'spawned' && message.pid) this.pid = message.pid;
            if (message.event === 'stopped' || message.event === 'dead') this.pid = null;
            onMessage?.(message);
            if (message.id !== undefined) {
              const pending = this.pending.get(message.id);
              if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error));
                else pending.resolve();
              }
            }
          } catch {
            reject(new Error('Invalid kernel bridge response'));
            void this.close();
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString('utf8')).slice(-32768);
      });
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.closed = true;
        reject(error);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.killKernel();
        onExit?.(error.message);
      };
      child.once('error', fail);
      child.once('exit', () => fail(new Error(this.stderr.trim() || 'Notebook kernel stopped')));
      child.stdin.on('error', () => {
        /* The exit handler rejects every pending operation. */
      });
    });
  }

  request(message: Record<string, unknown>, timeoutMs?: number): Promise<void> {
    if (this.closed || this.closePromise)
      return Promise.reject(new Error('Notebook kernel stopped'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error('Kernel operation timed out'));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.killKernel();
        this.child.kill('SIGKILL');
      }, 3000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin.end(`${JSON.stringify({ op: 'shutdown' })}\n`);
    });
    return this.closePromise;
  }

  private killKernel(): void {
    if (!this.pid) return;
    try {
      process.kill(-this.pid, 'SIGKILL');
    } catch {
      /* Already stopped by Jupyter. */
    }
    this.pid = null;
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(-512);
}
