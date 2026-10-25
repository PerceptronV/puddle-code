import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { notebookExecuteSchema } from '@puddle/shared';
import type { RepoStore } from '../src/db/stores/repos.js';
import type { SessionStore } from '../src/db/stores/sessions.js';
import { NO_SESSION } from '../src/http/routes/worktree-shared.js';
import { NotebookKernels } from '../src/notebooks/kernels.js';
import { findCodeExecutable } from '../src/code/discovery.js';

it('bounds submissions and rejects ambiguous cell identities', () => {
  const source = { session: NO_SESSION, root: '/project', path: 'example.ipynb' };
  expect(
    notebookExecuteSchema.safeParse({
      source,
      cells: [
        { id: 'same', source: '1' },
        { id: 'same', source: '2' },
      ],
    }).success,
  ).toBe(false);
  expect(
    notebookExecuteSchema.safeParse({
      source,
      cells: [{ id: 'large', source: 'x'.repeat(1024 * 1024 + 1) }],
    }).success,
  ).toBe(false);
  expect(notebookExecuteSchema.safeParse({ source, cells: [] }).success).toBe(false);
});

// A real Jupyter kernel, without starting puddled or inheriting an agent PTY.
it.skipIf(!findCodeExecutable(['jupyter-nbconvert']))(
  'streams selected cells, keeps kernel state, handles input and stops batches on error or interruption',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-notebook-live-')));
    const source = { session: NO_SESSION, root, path: 'example.ipynb' };
    writeFileSync(
      join(root, source.path),
      JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
    );
    const kernels = new NotebookKernels({ sessions: {} as SessionStore, repos: {} as RepoStore });
    onTestFinished(async () => {
      await kernels.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    const status = async () => (await kernels.executionStatus(source)).execution!;
    const finished = async () => {
      await expect.poll(async () => (await status()).state, { timeout: 30000 }).not.toBe('running');
      return status();
    };
    expect(
      await kernels.intelligence({ source, kind: 'complete', code: 'val', cursor: 3 }),
    ).toMatchObject({ matches: [] });
    expect((await kernels.status(source)).state).toBe('stopped');
    await kernels.executeCells({
      source,
      cells: [
        {
          id: 'setup',
          source: 'value = 41\nprint("early ✓", flush=True)\nimport time\ntime.sleep(2)',
        },
        { id: 'answer', source: 'print(value + 1)' },
      ],
    });
    await expect(
      kernels.executeCells({ source, cells: [{ id: 'overlap', source: '1' }] }),
    ).rejects.toThrow(/already running/);
    await expect
      .poll(async () => JSON.stringify((await status()).cells[0]?.outputs), {
        timeout: 30000,
        intervals: [100],
      })
      .toContain('early ✓');
    const first = await finished();
    expect(first.state).toBe('succeeded');
    expect(first.cells.map((cell) => cell.execution_count)).toEqual([1, 2]);
    expect(JSON.stringify(first.cells[1]!.outputs)).toContain('42');
    const code = '# 🙂\nval';
    const completion = await kernels.intelligence({
      source,
      kind: 'complete',
      code,
      cursor: [...code].length,
    });
    expect(completion.matches).toContain('value');
    expect(completion.start).toBe([...code].length - 3);
    const help = await kernels.intelligence({ source, kind: 'inspect', code: 'print', cursor: 5 });
    expect(help.documentation.toLowerCase()).toContain('print');

    await kernels.executeCells({
      source,
      cells: [{ id: 'input', source: 'name = input("Name: ")\nprint(name, value)' }],
    });
    await expect
      .poll(async () => (await status()).input?.prompt, { timeout: 10000 })
      .toBe('Name: ');
    const prompt = (await status()).input!;
    const run = await status();
    await expect(
      kernels.replyToInput({ source, run_id: first.id, input_id: prompt.id, value: 'wrong' }),
    ).rejects.toThrow(/no longer active/);
    await kernels.replyToInput({ source, run_id: run.id, input_id: prompt.id, value: 'Notebook' });
    expect(JSON.stringify((await finished()).cells[0]!.outputs)).toContain('Notebook 41');
    await kernels.executeCells({
      source,
      cells: [
        { id: 'error', source: 'print("before error")\nraise ValueError("example")' },
        { id: 'skipped', source: 'value = 0' },
      ],
    });
    const failed = await finished();
    expect(failed.state).toBe('failed');
    expect(failed.cells.map((cell) => cell.state)).toEqual(['failed', 'cancelled']);
    expect(JSON.stringify(failed.cells[0]!.outputs)).toContain('ValueError');
    await kernels.executeCells({
      source,
      cells: [
        { id: 'interrupt', source: 'print("waiting", flush=True)\ntime.sleep(60)' },
        { id: 'never', source: 'value = 0' },
      ],
    });
    await expect
      .poll(async () => JSON.stringify((await status()).cells[0]!.outputs), { timeout: 10000 })
      .toContain('waiting');
    await kernels.action({ source, action: 'interrupt' });
    expect((await finished()).state).toBe('cancelled');
    await kernels.executeCells({ source, cells: [{ id: 'retained', source: 'print(value)' }] });
    expect(JSON.stringify((await finished()).cells[0]!.outputs)).toContain('41');
    expect((await kernels.status(source)).state).toBe('idle');
  },
  60000,
);
