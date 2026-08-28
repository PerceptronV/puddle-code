import { z } from 'zod';
import { compilationFileTargetSchema } from './compilation.js';

/** POST /api/latex/synctex — inverse search from a PDF page point to TeX source. */
export const latexSynctexRequestSchema = compilationFileTargetSchema.extend({
  root: z.string().min(1),
  page: z.number().int().positive(),
  /** Big points (72 dpi) from the PDF page's top-left corner. */
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
});
export type LatexSynctexRequest = z.infer<typeof latexSynctexRequestSchema>;

export const latexSynctexResponseSchema = compilationFileTargetSchema.extend({
  line: z.number().int().positive(),
  /** SyncTeX may not resolve a meaningful column. */
  column: z.number().int().nonnegative().optional(),
});
export type LatexSynctexResponse = z.infer<typeof latexSynctexResponseSchema>;
