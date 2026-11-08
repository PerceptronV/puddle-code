import { z } from 'zod';
import { projectId } from '../common.js';
import { sessionSchema } from '../agents/sessions.js';
import {
  huddleDefinitionSchema,
  huddleLayoutSchema,
  huddleDiagnosticSchema,
} from './definitions.js';
import { huddleComponentSchema } from './components.js';
import { huddleIdSchema, huddleKeySchema } from './values.js';

/** Definition worktrees are explicit absolute roots, never implicit process cwd. */
export const huddleLocationSchema = z.strictObject({
  project_id: projectId,
  worktree: z.string().min(1).max(4096),
});
export type HuddleLocation = z.infer<typeof huddleLocationSchema>;
export const huddleCreateSchema = huddleLocationSchema.extend({
  name: z.string().trim().min(1).max(200),
});
export type HuddleCreate = z.infer<typeof huddleCreateSchema>;
export const huddleOpenSchema = huddleLocationSchema.extend({ huddle_id: huddleIdSchema });
export type HuddleOpen = z.infer<typeof huddleOpenSchema>;
/** One source file per publication; callers retain drafts until this write is observed. */
export const huddleSaveSchema = huddleOpenSchema.extend({
  expected_digest: z.string().regex(/^[a-f0-9]{64}$/),
  edit: z.discriminatedUnion('file', [
    z.strictObject({ file: z.literal('huddle.json'), value: huddleDefinitionSchema }),
    z.strictObject({ file: z.literal('layout.json'), value: huddleLayoutSchema }),
  ]),
});
export type HuddleSave = z.infer<typeof huddleSaveSchema>;
export const huddleAvailabilitySchema = z.discriminatedUnion('available', [
  z.strictObject({
    available: z.literal(true),
    build: z.string().min(1).max(200),
    lifetime: z.enum(['service', 'host_session']),
  }),
  z.strictObject({ available: z.literal(false), reason: z.string().max(1024) }),
]);
export const huddleDiscoverySchema = z
  .array(
    z.union([
      z.strictObject({
        id: huddleIdSchema,
        name: z.string(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        diagnostics: z.array(huddleDiagnosticSchema),
      }),
      z.strictObject({ id: huddleIdSchema, error: z.string().max(8192) }),
    ]),
  )
  .max(512);
/** Source stays in ordinary project files; inspection never evaluates a module. */
export const huddleDocumentSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  definition: huddleDefinitionSchema,
  layout: huddleLayoutSchema.optional(),
  components: z.record(huddleKeySchema, huddleComponentSchema),
  diagnostics: z.array(huddleDiagnosticSchema),
});
export const huddleOpenedSchema = z.strictObject({
  session: sessionSchema.extend({ kind: z.literal('huddle'), huddle_id: huddleIdSchema }),
  created: z.boolean(),
  document: huddleDocumentSchema,
});
export type HuddleAvailability = z.infer<typeof huddleAvailabilitySchema>;
export type HuddleDiscovery = z.infer<typeof huddleDiscoverySchema>;
export type HuddleDocument = z.infer<typeof huddleDocumentSchema>;
export type HuddleOpened = z.infer<typeof huddleOpenedSchema>;
