import { constants } from 'node:fs';
import { access, open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { NotebookEnvironment } from '@puddle/shared';
import { codeSearchDirectories } from '../code/discovery.js';
import {
  CompilationCommandError,
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../compilation/process.js';
import { KeyedMutex } from '../git/mutex.js';

const probe = `import importlib.util, json
print(json.dumps({name: importlib.util.find_spec(name) is not None for name in ('ipykernel', 'nbconvert')}))`;
const packagesSchema = z.object({ ipykernel: z.boolean(), nbconvert: z.boolean() });

/** Bounded host discovery includes Python installations without Jupyter packages. */
export class NotebookEnvironments {
  private readonly cache = new Map<string, { at: number; value: Promise<NotebookEnvironment> }>();
  private readonly installs = new KeyedMutex();

  constructor(
    private readonly home = homedir(),
    private readonly env = process.env,
    private readonly runner: CompilationCommandRunner = runCompilationCommand,
  ) {}

  async discover(source: string, root: string): Promise<NotebookEnvironment[]> {
    const candidates = new Set<string>();
    const add = async (path: string) => {
      if (candidates.size >= 32) return;
      const python = await this.resolvePython(path, dirname(source)).catch(() => null);
      if (python) candidates.add(python);
    };
    let directory = dirname(source);
    for (let depth = 0; depth < 16; depth++) {
      await add(join(directory, '.venv'));
      await add(join(directory, 'venv'));
      if (directory === root || dirname(directory) === directory) break;
      directory = dirname(directory);
    }
    for (const prefix of [this.env.VIRTUAL_ENV, this.env.CONDA_PREFIX]) {
      if (prefix) await add(prefix);
    }
    const prefixes = [
      this.env.MAMBA_ROOT_PREFIX,
      ...[
        'miniconda3',
        'anaconda3',
        'miniforge3',
        'mambaforge',
        'micromamba',
        'mamba',
        '.local/share/mamba',
        '.local/share/micromamba',
      ].map((name) => join(this.home, name)),
      '/opt/conda',
      '/opt/miniconda3',
      '/opt/anaconda3',
      '/opt/homebrew/Caskroom/miniforge/base',
    ].filter((path): path is string => !!path);
    for (const prefix of prefixes) await add(prefix);
    for (const directory of [
      ...prefixes.map((prefix) => join(prefix, 'envs')),
      join(this.home, '.conda/envs'),
    ]) {
      try {
        const entries = await opendir(directory);
        let count = 0;
        for await (const entry of entries) {
          if (++count > 64 || candidates.size >= 32) break;
          if (entry.isDirectory() || entry.isSymbolicLink()) await add(join(directory, entry.name));
        }
      } catch {
        /* Optional installation directory. */
      }
    }
    // Conda records environments outside its installation prefix here.
    try {
      const handle = await open(join(this.home, '.conda/environments.txt'), 'r');
      try {
        const bytes = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        for (const path of bytes.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 64)) {
          if (isAbsolute(path.trim())) await add(path.trim());
        }
      } finally {
        await handle.close();
      }
    } catch {
      /* Conda is optional. */
    }
    for (const directory of codeSearchDirectories(this.env, this.home).slice(0, 64)) {
      for (const name of ['python3', 'python']) {
        const python = join(directory, name);
        if (await this.executable(python)) {
          await add(python);
          break;
        }
      }
    }
    const paths = [...candidates];
    const results: NotebookEnvironment[] = [];
    // Probe at most four interpreters at once; no synchronous subprocess discovery.
    for (let index = 0; index < paths.length; index += 4)
      results.push(
        ...(await Promise.all(paths.slice(index, index + 4).map((path) => this.inspect(path)))),
      );
    return results;
  }

  async resolvePython(input: string, cwd: string): Promise<string> {
    const path = resolve(
      cwd,
      input === '~' ? this.home : input.startsWith('~/') ? join(this.home, input.slice(2)) : input,
    );
    if ((await stat(path)).isDirectory()) {
      for (const name of ['bin/python', 'bin/python3', 'Scripts/python.exe', 'python.exe']) {
        const python = join(path, name);
        if (await this.executable(python)) return python;
      }
      throw new Error(`No Python executable found in ${path}`);
    }
    if (!(await this.executable(path))) throw new Error(`Python is not executable: ${path}`);
    // Do not realpath: a venv's Python is commonly a symlink to the base interpreter.
    return path;
  }

  inspect(python: string, refresh = false): Promise<NotebookEnvironment> {
    const cached = this.cache.get(python);
    if (!refresh && cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = (async () => {
      const label = `${basename(dirname(dirname(python)))} (${basename(python)})`;
      try {
        const result = await this.runner({
          file: python,
          args: ['-c', probe],
          cwd: dirname(python),
          timeoutMs: 5000,
          maxOutputBytes: 8192,
        });
        return { python, label, ...packagesSchema.parse(JSON.parse(result.stdout)) };
      } catch (error) {
        return { python, label, ipykernel: false, nbconvert: false, error: failure(error) };
      }
    })();
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(python, { at: Date.now(), value });
    return value;
  }

  install(python: string): Promise<NotebookEnvironment> {
    return this.installs.run(python, async () => {
      const before = await this.inspect(python, true);
      if (before.error) throw new Error(before.error);
      const missing = [!before.ipykernel && 'ipykernel', !before.nbconvert && 'nbconvert'].filter(
        (name): name is string => !!name,
      );
      if (missing.length) {
        try {
          await this.runner({
            file: python,
            args: ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...missing],
            cwd: dirname(python),
            timeoutMs: 120_000,
            maxOutputBytes: 128 * 1024,
          });
        } catch (error) {
          throw new Error(failure(error), { cause: error });
        }
      }
      const after = await this.inspect(python, true);
      if (after.error || !after.ipykernel || !after.nbconvert)
        throw new Error(
          after.error ?? 'Installation finished but notebook packages are still unavailable',
        );
      return after;
    });
  }

  private async executable(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }
}

function failure(error: unknown): string {
  if (error instanceof CompilationCommandError && error.result?.stderr.trim())
    return error.result.stderr.trim().slice(-2048);
  return (error instanceof Error ? error.message : String(error)).slice(-2048);
}
