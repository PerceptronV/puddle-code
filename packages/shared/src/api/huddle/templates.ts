import { z } from 'zod';
import { huddleOpenSchema } from './authoring.js';
import { huddleComponentSchema } from './components.js';
import { huddleKeySchema, huddleRelativePathSchema } from './values.js';

export const huddleInstallTemplateSchema = huddleOpenSchema.extend({
  template: z.enum([
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
});
export type HuddleInstallTemplate = z.infer<typeof huddleInstallTemplateSchema>;
export const huddleInstalledTemplateSchema = z.strictObject({
  manifest: huddleRelativePathSchema,
  component: huddleComponentSchema,
});
