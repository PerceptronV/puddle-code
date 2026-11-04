import { dirname } from 'node:path';
import { runCompilationCommand } from '../../../src/compilation/process.js';

/** A separate interpreter prefix using the fixture's already installed packages. */
export async function notebookPythonEnvironment(python: string, directory: string): Promise<void> {
  await runCompilationCommand({
    file: python,
    args: [
      '-c',
      `import json, pathlib, subprocess, sys, sysconfig, venv
target = pathlib.Path(sys.argv[1])
venv.EnvBuilder(with_pip=False).create(target)
interpreter = target / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
paths = json.loads(subprocess.check_output([
    str(interpreter), '-I', '-c',
    'import json, sysconfig; print(json.dumps(sysconfig.get_paths()))',
], text=True))
# --system-site-packages inherits the BASE Python, not the invoking venv.
# CI installs Jupyter in a venv; expose those exact package directories without
# copying executables, downloading packages or changing the selected prefix.
packages = sorted({sysconfig.get_path('purelib'), sysconfig.get_path('platlib')})
(pathlib.Path(paths['purelib']) / 'puddle-test-packages.pth').write_text(
    ''.join(path + '\\n' for path in packages), encoding='utf-8')
`,
      directory,
    ],
    cwd: dirname(directory),
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024,
  });
}
