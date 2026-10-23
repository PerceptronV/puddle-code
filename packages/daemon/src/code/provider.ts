import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import type { CompilationFileTarget } from '@puddle/shared';
import type {
  CompilationProvider,
  CompilationProviderResult,
  CompilationRunOptions,
} from '../compilation/provider.js';
import { expandCommandTemplate } from '../compilation/command-template.js';
import {
  CompilationCommandError,
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../compilation/process.js';
import { KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';
import { containedPath, resolveFsRoot, type WorktreeDeps } from '../http/routes/worktree-shared.js';
import { codeSearchDirectories, findCodeExecutable } from './discovery.js';
import { CODE_RECIPES, recipeCommand, type CodeRecipe } from './recipes.js';

interface CodeProviderDeps extends WorktreeDeps {
  discover?: (names: readonly string[]) => string | null;
  runner?: CompilationCommandRunner;
  timeoutMs?: number;
}

/** Manual host execution through the ordinary compilation lifecycle and authority. */
export class CodeProvider implements CompilationProvider {
  readonly eager = false;
  readonly action = 'run';
  private readonly mutex = new KeyedMutex();
  private disposed = false;

  constructor(
    readonly recipe: CodeRecipe,
    private readonly deps: CodeProviderDeps,
  ) {}

  get id() {
    return this.recipe.id;
  }
  get displayName() {
    return this.recipe.name;
  }
  get extensions() {
    return this.recipe.extensions;
  }
  get inputExtensions() {
    return this.recipe.inputs ?? this.recipe.extensions;
  }

  capability() {
    const executor = (this.deps.discover ?? findCodeExecutable)(this.recipe.executables);
    return { available: executor !== null, executor };
  }

  commandConfiguration(request: CompilationFileTarget) {
    const { absolute } = this.source(request);
    const { executor } = this.capability();
    return {
      filePath: realpathSync(absolute),
      fileType: this.id,
      variables: [
        { placeholder: '{{source}}', description: 'Absolute path of this source file' },
        {
          placeholder: '{{output_dir}}',
          description: 'Managed directory for this run below the source root’s .puddle',
        },
        ...(this.recipe.compiled
          ? [
              {
                placeholder: '{{binary}}',
                description: 'Executable to build; Puddle runs it after the compiler succeeds',
              },
            ]
          : []),
      ],
      defaults: { on_demand: executor ? recipeCommand(this.recipe, executor) : null },
    };
  }

  validateCommand(_request: CompilationFileTarget, command: string): void {
    expandCommandTemplate(command, {
      source: '/source/file',
      output_dir: '/source/.puddle/run',
      ...(this.recipe.compiled ? { binary: '/source/.puddle/run/programme' } : {}),
    });
    const required = this.recipe.compiled
      ? '{{binary}}'
      : this.recipe.notebook
        ? '{{output_dir}}'
        : null;
    if (required && !command.includes(required)) {
      throw ApiError.badRequest(
        'invalid_compilation_command',
        `${this.displayName} commands must use ${required} for the managed output`,
      );
    }
  }

  watchInputs(request: CompilationFileTarget): string[] {
    return [this.source(request).absolute];
  }

  async run(
    request: CompilationFileTarget,
    options: CompilationRunOptions,
  ): Promise<CompilationProviderResult> {
    if (options.mode !== 'on_demand') {
      throw ApiError.badRequest(
        'eager_compilation_unsupported',
        'Code runs only when explicitly requested',
      );
    }
    const { root, absolute } = this.source(request);
    const identity = realpathSync(absolute);
    return this.mutex.run(identity, async () => {
      if (this.disposed) throw ApiError.conflict('compiler_disposed', 'Code runner is closed');
      const { executor } = this.capability();
      if (!executor)
        throw new ApiError(
          424,
          'compiler_not_installed',
          `${this.displayName} is not available on the daemon host`,
        );
      const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
      const buildRoot = join(root, '.puddle', 'code', this.id, key);
      const runs = join(buildRoot, 'runs');
      const runDir = join(runs, `${Date.now()}-${randomUUID()}`);
      const current = join(buildRoot, 'current');
      const binary = join(runDir, 'programme');
      const template = options.command ?? recipeCommand(this.recipe, executor);
      this.validateCommand(request, template);
      const command = expandCommandTemplate(template, {
        source: absolute,
        output_dir: runDir,
        binary,
      });
      const runner = this.deps.runner ?? runCompilationCommand;
      const context = {
        cwd: dirname(absolute),
        env: { ...process.env, PATH: codeSearchDirectories().join(delimiter) },
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      };
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      let output = '';
      try {
        const result = await runner({ ...command, ...context });
        output += result.stdout + result.stderr;
        if (this.recipe.compiled) {
          const executed = await runner({ file: binary, args: [], ...context });
          output += executed.stdout + executed.stderr;
        }
        await writeFile(
          join(runDir, 'output.txt'),
          output || 'Finished successfully (no output).\n',
          { mode: 0o600 },
        );
        const outputName = this.recipe.notebook ? 'notebook.ipynb' : 'output.txt';
        const product = join(runDir, outputName);
        const artifactName = this.recipe.notebook
          ? `${basename(request.path, '.ipynb')}.executed.ipynb`
          : `${basename(request.path)}.output.txt`;
        const info = await stat(product);
        if (!info.isFile() || info.size > 5 * 1024 * 1024) {
          throw new Error('Run output exceeds the 5 MiB editor limit');
        }
        await mkdir(current, { recursive: true, mode: 0o700 });
        const next = join(current, `${artifactName}.next-${randomUUID()}`);
        try {
          await copyFile(product, next);
          await rename(next, join(current, artifactName));
        } finally {
          await rm(next, { force: true });
        }
        return {
          executor: basename(command.file),
          source: request,
          dependencies: [absolute],
          artifacts: [
            {
              role: 'preview',
              media_type: this.recipe.notebook ? 'application/x-ipynb+json' : 'text/plain',
              file: { session: request.session, root: current, path: artifactName },
            },
          ],
        };
      } catch (error) {
        if (error instanceof CompilationCommandError && error.result)
          output += error.result.stdout + error.result.stderr;
        await writeFile(join(runDir, 'output.txt'), output, { mode: 0o600 });
        throw new ApiError(
          422,
          'code_run_failed',
          error instanceof Error ? error.message : String(error),
          {
            source: request,
            output: output.slice(-2 * 1024 * 1024),
          },
        );
      } finally {
        const entries = await readdir(runs, { withFileTypes: true });
        for (const entry of entries
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => b.name.localeCompare(a.name))
          .slice(5)) {
          await rm(join(runs, entry.name), { recursive: true, force: true });
        }
      }
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  private source(request: CompilationFileTarget) {
    const root = resolveFsRoot(this.deps, request.session, request.root);
    const absolute = containedPath(root, request.path);
    const extension = request.path.split('.').pop()?.toLowerCase();
    if (!extension || !this.extensions.includes(extension)) {
      throw ApiError.badRequest(
        'compiler_not_supported',
        `${this.displayName} does not support ${request.path}`,
      );
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile())
      throw ApiError.notFound('code source', request.path);
    return { root, absolute };
  }
}

export function createCodeProviders(deps: CodeProviderDeps): CodeProvider[] {
  return CODE_RECIPES.map((recipe) => new CodeProvider(recipe, deps));
}
