import { Hono } from 'hono';
import {
  compilationModeRequestSchema,
  compilationRunRequestSchema,
  compilationTargetRequestSchema,
  type CompilationCapabilitiesResponse,
  type CompilationRunResponse,
  type CompilationStatusResponse,
} from '@puddle/shared';
import type { CompilationService } from '../../compilation/service.js';
import { parseBody } from '../validate.js';

export function compilationRoutes(deps: { compilation: CompilationService }): Hono {
  return new Hono()
    .get('/capabilities', (c) =>
      c.json<CompilationCapabilitiesResponse>(deps.compilation.capabilities()),
    )
    .post('/run', async (c) => {
      const request = await parseBody(c, compilationRunRequestSchema);
      return c.json<CompilationRunResponse>(await deps.compilation.run(request));
    })
    .put('/mode', async (c) => {
      const request = await parseBody(c, compilationModeRequestSchema);
      return c.json<CompilationStatusResponse>(await deps.compilation.setMode(request));
    })
    .post('/status', async (c) => {
      const request = await parseBody(c, compilationTargetRequestSchema);
      return c.json<CompilationStatusResponse>(deps.compilation.status(request));
    });
}
