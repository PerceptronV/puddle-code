import { randomUUID } from 'node:crypto';
import type { NotebookExecution, NotebookExecute, NotebookInputReply } from '@puddle/shared';
import type { messageSchema } from './kernel-bridge.js';
import type { z } from 'zod';

/** One bounded latest run per canonical notebook; reconnect observes and never replays it. */
export class NotebookExecutionController {
  private current: NotebookExecution | null = null;
  begin(cells: NotebookExecute['cells']): NotebookExecution {
    this.current = {
      id: randomUUID(),
      revision: 0,
      state: 'running',
      cells: cells.map((cell) => ({
        ...cell,
        state: 'queued',
        revision: 0,
        outputs: [],
        execution_count: null,
      })),
    };
    return this.current;
  }
  snapshot(): NotebookExecution | null {
    return this.current;
  }
  receive(message: z.infer<typeof messageSchema>): void {
    const run = this.current;
    if (!run || run.state !== 'running' || message.run_id !== run.id) return;
    if (message.event === 'cell' && message.cell) {
      const index = run.cells.findIndex((cell) => cell.id === message.cell!.id);
      if (index < 0 || run.cells[index]!.source !== message.cell.source) return;
      run.cells[index] = { ...message.cell, revision: run.cells[index]!.revision + 1 };
    } else if (message.event === 'input' && message.input) run.input = message.input;
    else if (message.event === 'input-cleared') delete run.input;
    else return;
    run.revision++;
  }
  acceptsInput(request: NotebookInputReply): boolean {
    return (
      this.current?.state === 'running' &&
      this.current.id === request.run_id &&
      this.current.input?.id === request.input_id
    );
  }
  finish(state: NotebookExecution['state'], error?: string): void {
    const run = this.current;
    if (!run) return;
    run.state = state;
    run.error = error;
    delete run.input;
    for (const cell of run.cells)
      if (cell.state === 'queued' || cell.state === 'running') {
        cell.revision++;
        cell.state = state === 'failed' && cell.state === 'running' ? 'failed' : 'cancelled';
      }
    run.revision++;
  }
}
