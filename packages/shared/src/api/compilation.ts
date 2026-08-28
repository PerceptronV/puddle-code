import { z } from 'zod';
import { sessionId } from './common.js';

/** How a compilable source is driven while its tab is open. */
export const compilationModeSchema = z.enum(['on_demand', 'eager']);
export type CompilationMode = z.infer<typeof compilationModeSchema>;

/** A source or generated file addressed through Puddle's existing file-tab convention. */
export const compilationFileTargetSchema = z.object({
  session: sessionId,
  path: z.string().min(1),
  /** Absolute browse root for an external file; absent for a worktree source. */
  root: z.string().min(1).optional(),
});
export type CompilationFileTarget = z.infer<typeof compilationFileTargetSchema>;

export const compilationProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

/** One modular daemon provider; LaTeX is the first, not a special case in the runner. */
export const compilationProviderSchema = z.object({
  id: compilationProviderIdSchema,
  display_name: z.string().min(1),
  extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
  /** Open dependency buffers saved before a build, in addition to the entry source. */
  input_extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
  available: z.boolean(),
  /** The preferred host executable when available, for honest capability UI. */
  executor: z.string().min(1).nullable(),
  eager: z.boolean(),
});
export type CompilationProvider = z.infer<typeof compilationProviderSchema>;

/** GET /api/compilation/capabilities — capabilities of the daemon host. */
export const compilationCapabilitiesResponseSchema = z.object({
  providers: z.array(compilationProviderSchema),
});
export type CompilationCapabilitiesResponse = z.infer<typeof compilationCapabilitiesResponseSchema>;

export const compilationTargetRequestSchema = z.object({
  source: compilationFileTargetSchema,
  /** Usually inferred from the extension; explicit for future ambiguous providers. */
  provider: compilationProviderIdSchema.optional(),
});
export type CompilationTargetRequest = z.infer<typeof compilationTargetRequestSchema>;

/** POST /api/compilation/run — one explicit or eager provider run. */
export const compilationRunRequestSchema = compilationTargetRequestSchema;
export type CompilationRunRequest = z.infer<typeof compilationRunRequestSchema>;

export const compilationArtifactSchema = z.object({
  /** Semantic role understood by the UI; `preview` is the primary visual output. */
  role: z.string().min(1),
  media_type: z.string().min(1),
  file: compilationFileTargetSchema,
});
export type CompilationArtifact = z.infer<typeof compilationArtifactSchema>;

export const compilationRunResponseSchema = z.object({
  provider: compilationProviderIdSchema,
  executor: z.string().min(1),
  /** Monotonic for this source/provider within the daemon lifetime. */
  revision: z.number().int().nonnegative(),
  /** The provider-resolved entry point (for LaTeX, the root TeX document). */
  source: compilationFileTargetSchema,
  artifacts: z.array(compilationArtifactSchema),
  /** Provider-owned navigation format available for the artifacts, if any. */
  navigation: z.object({ kind: z.string().min(1) }).optional(),
});
export type CompilationRunResponse = z.infer<typeof compilationRunResponseSchema>;

/** PUT /api/compilation/mode — register or retire daemon-observed eager compilation. */
export const compilationModeRequestSchema = compilationTargetRequestSchema.extend({
  mode: compilationModeSchema,
});
export type CompilationModeRequest = z.infer<typeof compilationModeRequestSchema>;

export const compilationStatusResponseSchema = z.object({
  provider: compilationProviderIdSchema,
  mode: compilationModeSchema,
  state: z.enum(['idle', 'running', 'succeeded', 'failed']),
  revision: z.number().int().nonnegative(),
  result: compilationRunResponseSchema.nullable(),
  error: z
    .object({
      message: z.string(),
    })
    .nullable(),
});
export type CompilationStatusResponse = z.infer<typeof compilationStatusResponseSchema>;
