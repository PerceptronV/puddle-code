import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { notebookExecutionRequestSchema, notebookObservationResponseSchema } from '@puddle/shared';
import { notebookRoutes } from '../../src/http/routes/execution/notebooks.js';
import { NotebookExecutionController } from '../../src/notebooks/execution.js';

const source = {
  session: '00000000-0000-0000-0000-000000000000',
  root: '/synthetic',
  path: 'example.ipynb',
};
function fixture() {
  let controller = new NotebookExecutionController();
  const executionStatus = vi.fn(async () => ({ execution: controller.snapshot() }));
  const app = new Hono().route(
    '/notebooks',
    notebookRoutes({
      executionStatus,
      catalogue: vi.fn(),
      status: vi.fn(),
      action: vi.fn(),
      environments: vi.fn(),
      executeCells: vi.fn(),
      replyToInput: vi.fn(),
      intelligence: vi.fn(),
      widgetState: vi.fn(),
      widgetComm: vi.fn(),
    }),
  );
  const observe = async (known?: { id: string; revision: number } | null) => {
    const response = await app.request('/notebooks/execution', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, ...(known !== undefined ? { known } : {}) }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    return {
      bytes: Buffer.byteLength(text),
      value: notebookObservationResponseSchema.parse(JSON.parse(text)),
    };
  };
  return {
    controller,
    observe,
    reset: () => {
      controller = new NotebookExecutionController();
    },
    executionStatus,
  };
}

it('omits full snapshot encoding for unchanged running/completed notebooks and restores full initial/reconnect replies', async () => {
  const { controller, observe } = fixture();
  const run = controller.begin(
    Array.from({ length: 100 }, (_, i) => ({ id: String(i), source: 'print(1)' })),
  );
  for (const cell of run.cells)
    controller.receive({
      event: 'cell',
      run_id: run.id,
      cell: {
        ...cell,
        state: 'succeeded',
        outputs: [{ output_type: 'stream', text: 'x'.repeat(10 * 1024) }],
      },
    });
  const encodeCells = vi.fn(() => Array.from(run.cells));
  Object.defineProperty(run.cells, 'toJSON', { value: encodeCells });
  expect((await observe()).bytes).toBeGreaterThan(1_000_000);
  expect(encodeCells).toHaveBeenCalledTimes(1);
  const known = { id: run.id, revision: run.revision };
  for (let i = 0; i < 5; i++)
    expect(await observe(known)).toEqual({ bytes: 18, value: { unchanged: true } });
  expect(encodeCells).toHaveBeenCalledTimes(1);
  controller.finish('succeeded');
  expect((await observe(known)).bytes).toBeGreaterThan(1_000_000);
  const finished = { id: run.id, revision: run.revision };
  expect((await observe(finished)).value).toEqual({ unchanged: true });
  expect(encodeCells).toHaveBeenCalledTimes(2);
  // Omitting known is always a full response, even when finished.
  expect((await observe()).bytes).toBeGreaterThan(1_000_000);
  expect(encodeCells).toHaveBeenCalledTimes(3);
});

it('observes changed cells, input prompts, prompt clearing, cancellation, other-window runs and daemon replacement', async () => {
  const { controller, observe, reset } = fixture();
  expect((await observe()).value).toEqual({ execution: null });
  expect((await observe(null)).value).toEqual({ unchanged: true });
  const run = controller.begin([{ id: 'cell', source: 'input()' }]);
  expect((await observe(null)).value).toHaveProperty('execution.id', run.id);
  let known = { id: run.id, revision: run.revision };
  controller.receive({
    event: 'cell',
    run_id: run.id,
    cell: {
      ...run.cells[0]!,
      state: 'running',
      outputs: [{ output_type: 'stream', text: 'waiting' }],
    },
  });
  expect((await observe(known)).value).toHaveProperty(
    'execution.cells.0.outputs.0.text',
    'waiting',
  );
  known = { id: run.id, revision: run.revision };
  const input = { id: '00000000-0000-4000-8000-000000000001', prompt: 'value', password: false };
  controller.receive({ event: 'input', run_id: run.id, input });
  expect((await observe(known)).value).toHaveProperty('execution.input', input);
  expect(controller.acceptsInput({ source, run_id: run.id, input_id: input.id, value: 'x' })).toBe(
    true,
  );
  known = { id: run.id, revision: run.revision };
  controller.receive({ event: 'input-cleared', run_id: run.id });
  expect((await observe(known)).value).not.toHaveProperty('execution.input');
  known = { id: run.id, revision: run.revision };
  controller.finish('cancelled');
  expect((await observe(known)).value).toHaveProperty('execution.state', 'cancelled');
  const other = controller.begin([{ id: 'cell', source: 'other window' }]);
  // Same revision is insufficient: another run has a different identity.
  expect((await observe({ id: run.id, revision: 0 })).value).toHaveProperty(
    'execution.id',
    other.id,
  );
  reset();
  expect((await observe({ id: other.id, revision: 0 })).value).toEqual({ execution: null });
});

it('validates observation identity and bounds revisions without changing legacy requests', () => {
  expect(notebookExecutionRequestSchema.parse({ source })).toEqual({ source });
  expect(notebookExecutionRequestSchema.parse({ source, known: null })).toHaveProperty(
    'known',
    null,
  );
  for (const known of [
    { id: 'bad', revision: 0 },
    { id: source.session, revision: -1 },
    { id: source.session, revision: 0.5 },
  ])
    expect(notebookExecutionRequestSchema.safeParse({ source, known }).success).toBe(false);
});
