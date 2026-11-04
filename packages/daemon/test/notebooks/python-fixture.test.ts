import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { findCodeExecutable } from '../../src/code/discovery.js';
import { runCompilationCommand } from '../../src/compilation/process.js';
import { notebookPythonEnvironment } from '../helpers/notebooks/python.js';

const python = findCodeExecutable(['python3', 'python']);

it.skipIf(!python)(
  'makes source-venv packages available while preserving the selected prefix',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'puddle-python-fixture-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, 'source');
    const selected = join(root, 'selected env');
    await runCompilationCommand({
      file: python!,
      args: ['-m', 'venv', '--without-pip', source],
      cwd: root,
    });
    const sourcePython = join(source, 'bin/python');
    const packages = await runCompilationCommand({
      file: sourcePython,
      args: ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
      cwd: root,
    });
    writeFileSync(
      join(packages.stdout.trim(), 'puddle_fixture_package.py'),
      'value = "source venv"\n',
    );
    await notebookPythonEnvironment(sourcePython, selected);
    const result = await runCompilationCommand({
      file: join(selected, 'bin/python'),
      args: [
        '-I',
        '-c',
        'import json, sys, puddle_fixture_package; print(json.dumps([sys.prefix, puddle_fixture_package.value]))',
      ],
      cwd: root,
    });
    expect(JSON.parse(result.stdout)).toEqual([selected, 'source venv']);
  },
);
