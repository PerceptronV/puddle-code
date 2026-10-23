import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compilationCapabilitiesResponseSchema } from '@puddle/shared';
import { CodeProvider, createCodeProviders } from '../src/code/provider.js';
import { findCodeExecutable } from '../src/code/discovery.js';
import { CODE_RECIPES } from '../src/code/recipes.js';
import { CompilationService } from '../src/compilation/service.js';
import {
  CompilationCommandError,
  runCompilationCommand,
  type CompilationCommand,
} from '../src/compilation/process.js';
import { commandTemplate } from '../src/compilation/command-template.js';
import type { RepoStore } from '../src/db/stores/repos.js';
import type { SessionStore } from '../src/db/stores/sessions.js';
import { NO_SESSION } from '../src/http/routes/worktree-shared.js';

const roots: string[] = [];
const deps = { sessions: {} as SessionStore, repos: {} as RepoStore };
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'puddle code '));
  roots.push(root);
  return root;
}
function recipe(id: string) {
  return CODE_RECIPES.find((recipe) => recipe.id === id)!;
}
const options = { mode: 'on_demand', command: null } as const;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('code providers', () => {
  it('advertises valid capabilities and rejects eager execution without running code', async () => {
    const root = directory();
    writeFileSync(join(root, 'hello.py'), 'print(1)');
    const service = new CompilationService(createCodeProviders({ ...deps, discover: () => null }));
    try {
      const capabilities = compilationCapabilitiesResponseSchema.parse(service.capabilities());
      expect(capabilities.providers).toHaveLength(CODE_RECIPES.length);
      expect(
        capabilities.providers.every(
          (provider) => !provider.eager && !provider.available && provider.action === 'run',
        ),
      ).toBe(true);
      const request = { source: { session: NO_SESSION, root, path: 'hello.py' } };
      await expect(service.setMode({ ...request, mode: 'eager' })).rejects.toThrow(
        /does not support eager/,
      );
      await expect(service.run(request)).rejects.toThrow(/not available/);
    } finally {
      service.dispose();
    }
  });

  it('runs literal paths without a shell and atomically replaces the stable output', async () => {
    const root = directory();
    const path = 'hello $(touch unwanted).js';
    writeFileSync(join(root, path), 'console.log("first"); console.error("warning");');
    const provider = new CodeProvider(recipe('javascript'), {
      ...deps,
      discover: () => process.execPath,
    });
    const source = { session: NO_SESSION, root, path };
    const first = await provider.run(source, options);
    const file = first.artifacts[0]!.file;
    expect(file.root).toContain(join(root, '.puddle', 'code'));
    expect(readFileSync(join(file.root!, file.path), 'utf8')).toBe('first\nwarning\n');
    writeFileSync(join(root, path), 'console.log("second");');
    const second = await provider.run(source, options);
    expect(second.artifacts[0]!.file).toEqual(file);
    expect(readFileSync(join(file.root!, file.path), 'utf8')).toBe('second\n');
    writeFileSync(join(root, path), 'console.error("broken"); process.exit(3);');
    await expect(provider.run(source, options)).rejects.toMatchObject({
      code: 'code_run_failed',
      details: { output: 'broken\n', source },
    });
    expect(readFileSync(join(file.root!, file.path), 'utf8')).toBe('second\n');
    expect(readdirSync(root)).not.toContain('unwanted');
    await expect(provider.run({ ...source, path: '../escape.js' }, options)).rejects.toThrow(
      /escapes/,
    );
  });

  it.each(['c', 'cpp', 'rust'])(
    'executes %s output only after a successful compile',
    async (id) => {
      const root = directory();
      const path = `main.${recipe(id).extensions[0]}`;
      writeFileSync(join(root, path), 'source');
      const commands: CompilationCommand[] = [];
      let fail = false;
      const provider = new CodeProvider(recipe(id), {
        ...deps,
        discover: () => '/tools/compiler',
        runner: async (command) => {
          commands.push(command);
          if (command.file === '/tools/compiler') {
            if (fail)
              throw new CompilationCommandError('compile failed', command, {
                exitCode: 1,
                stdout: '',
                stderr: 'syntax error',
              });
            const binary = command.args[command.args.indexOf('-o') + 1]!;
            writeFileSync(binary, 'executable');
          }
          return { exitCode: 0, stdout: 'ok\n', stderr: '' };
        },
      });
      const source = { session: NO_SESSION, root, path };
      const result = await provider.run(source, options);
      expect(commands).toHaveLength(2);
      expect(commands[1]!.file).toBe(commands[0]!.args[2]);
      expect(commands[1]!.cwd).toBe(root);
      expect(commands[1]!.args).toEqual([]);
      expect(result.artifacts[0]!.media_type).toBe('text/plain');
      commands.length = 0;
      fail = true;
      await expect(provider.run(source, options)).rejects.toThrow('compile failed');
      expect(commands).toHaveLength(1);
      expect(() => provider.validateCommand(source, 'cc {{source}}')).toThrow(/binary/);
    },
  );

  it('runs custom arguments and keeps at most five fresh run directories', async () => {
    const root = directory();
    writeFileSync(join(root, 'main.js'), 'console.log(process.argv[2]);');
    const provider = new CodeProvider(recipe('javascript'), {
      ...deps,
      discover: () => process.execPath,
    });
    const source = { session: NO_SESSION, root, path: 'main.js' };
    for (let run = 0; run < 6; run++) {
      const result = await provider.run(source, {
        ...options,
        command: commandTemplate(process.execPath, ['{{source}}', `run ${run}`]),
      });
      const file = result.artifacts[0]!.file;
      expect(readFileSync(join(file.root!, file.path), 'utf8')).toBe(`run ${run}\n`);
      expect(readdirSync(join(dirname(file.root!), 'runs')).length).toBeLessThanOrEqual(5);
    }
    expect(() => provider.validateCommand(source, 'node {{source}} && echo nope')).toThrow(
      /without a shell/,
    );
  });

  it('executes notebooks into a separate result and preserves the original document', async () => {
    const root = directory();
    const original = '{"cells":[]}';
    writeFileSync(join(root, 'analysis.ipynb'), original);
    const provider = new CodeProvider(recipe('notebook'), {
      ...deps,
      discover: () => '/tools/jupyter-nbconvert',
      runner: async (command) => {
        expect(command.args).toContain('--execute');
        expect(command.args).not.toContain('--inplace');
        expect(command.cwd).toBe(root);
        const out = command.args[command.args.indexOf('--output-dir') + 1]!;
        writeFileSync(join(out, 'notebook.ipynb'), '{"cells":[{"outputs":[]}]}');
        return { exitCode: 0, stdout: '', stderr: 'Executed' };
      },
    });
    const result = await provider.run(
      { session: NO_SESSION, root, path: 'analysis.ipynb' },
      options,
    );
    expect(result.artifacts[0]!.media_type).toBe('application/x-ipynb+json');
    expect(readFileSync(join(root, 'analysis.ipynb'), 'utf8')).toBe(original);
    const output = result.artifacts[0]!.file;
    expect(readFileSync(join(output.root!, output.path), 'utf8')).toContain('outputs');
  });
});

describe('code tool discovery and process bounds', () => {
  it('finds compiler alternatives while ignoring non-executable files', () => {
    const bin = directory();
    writeFileSync(join(bin, 'cc'), 'not executable');
    writeFileSync(join(bin, 'clang'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'clang'), 0o700);
    expect(findCodeExecutable(['cc', 'clang', 'gcc'], [bin])).toBe(join(bin, 'clang'));
    expect(findCodeExecutable(['python3'], [bin])).toBeNull();
  });

  it('bounds runtime and captured output', async () => {
    const cwd = directory();
    await expect(
      runCompilationCommand({
        file: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/exceeded 50 ms/);
    await expect(
      runCompilationCommand({
        file: process.execPath,
        args: ['-e', 'console.log("x".repeat(10000))'],
        cwd,
        maxOutputBytes: 100,
      }),
    ).rejects.toThrow(/output exceeded/);
  });
});
