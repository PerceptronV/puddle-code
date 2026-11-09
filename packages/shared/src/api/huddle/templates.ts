import { z } from 'zod';
import { huddleOpenSchema } from './authoring.js';
import { huddleComponentSchema, huddleComponentIdSchema } from './components.js';
import { huddleKeySchema, huddleRelativePathSchema } from './values.js';

export const huddleInstallTemplateSchema = huddleOpenSchema
  .extend({
    template: z.enum([
      'builtin',
      'transform',
      'format-text',
      'condition',
      'merge',
      'join',
      'write-report',
      'native-prompt-agent',
      'native-review-agent',
      'resume-agent',
      'restart-agent',
      'prompt-agent',
      'review-agent',
      'spawn-agent',
      'prompt-spawned-agent',
      'review-spawned-agent',
    ]),
    component: huddleKeySchema,
    builtin: z
      .strictObject({ component: huddleComponentIdSchema, version: z.number().int().positive() })
      .optional(),
  })
  .refine(
    (input) => (input.template === 'builtin') === (input.builtin !== undefined),
    'Only builtin copies require a pinned builtin reference',
  );
export type HuddleInstallTemplate = z.infer<typeof huddleInstallTemplateSchema>;
export const huddleInstallTemplateBodySchema = z
  .strictObject(huddleInstallTemplateSchema.shape)
  .omit({ huddle_id: true });
export const huddleInstalledTemplateSchema = z.strictObject({
  manifest: huddleRelativePathSchema,
  component: huddleComponentSchema,
});
