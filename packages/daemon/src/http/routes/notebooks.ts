import { Hono } from 'hono';
import { notebookKernelActionSchema, notebookKernelRequestSchema } from '@puddle/shared';
import type { NotebookKernels } from '../../notebooks/kernels.js';
import { parseBody } from '../validate.js';

export function notebookRoutes(
  kernels: Pick<NotebookKernels, 'catalogue' | 'status' | 'action'>,
): Hono {
  return new Hono()
    .get('/kernels', async (c) => c.json(await kernels.catalogue()))
    .post('/status', async (c) => {
      const request = await parseBody(c, notebookKernelRequestSchema);
      return c.json(await kernels.status(request.source));
    })
    .post('/kernel', async (c) => {
      const request = await parseBody(c, notebookKernelActionSchema);
      return c.json(await kernels.action(request));
    });
}
