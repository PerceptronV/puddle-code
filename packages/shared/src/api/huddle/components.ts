import { z } from 'zod';
import { PROFILE_ICON_COLOURS } from '../profiles.js';
import { huddleParametersSchema, huddlePortsSchema } from './contracts.js';
import { HUDDLE_LIMITS, huddleRelativePathSchema } from './values.js';

export const huddleComponentIdSchema = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
export const huddleAppearanceSchema = z.strictObject({
  icon: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/)
    .nullable()
    .default(null),
  colour: z
    .union([z.enum(PROFILE_ICON_COLOURS), z.string().regex(/^#[0-9a-fA-F]{6}$/)])
    .nullable()
    .default(null),
});

export const huddleComponentSchema = z
  .strictObject({
    format: z.literal(1),
    id: huddleComponentIdSchema,
    version: z.number().int().positive(),
    category: z.enum(['trigger', 'script', 'readout']),
    title: z.string().min(1).max(200),
    description: z.string().max(4096).default(''),
    inputs: huddlePortsSchema.default({}),
    outputs: huddlePortsSchema.default({}),
    parameters: huddleParametersSchema.default({}),
    capabilities: z
      .array(z.enum(['files', 'git', 'sessions', 'clock', 'network']))
      .max(5)
      .default([]),
    activation: z.enum(['all', 'any']).default('all'),
    appearance: huddleAppearanceSchema.optional(),
    entry: huddleRelativePathSchema.optional(),
    dependencies: z.array(huddleRelativePathSchema).max(HUDDLE_LIMITS.files).default([]),
  })
  .superRefine((component, ctx) => {
    if (component.category === 'trigger' && Object.keys(component.inputs).length)
      ctx.addIssue({
        code: 'custom',
        path: ['inputs'],
        message: 'Triggers cannot have input ports',
      });
    if (component.category === 'trigger' && !Object.keys(component.outputs).length)
      ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'Triggers need an output port' });
    if (component.category !== 'trigger' && !Object.keys(component.inputs).length)
      ctx.addIssue({
        code: 'custom',
        path: ['inputs'],
        message: 'Script/readout nodes need an input port',
      });
    if (new Set(component.capabilities).size !== component.capabilities.length)
      ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'Duplicate capability' });
    if (
      component.capabilities.some((capability) =>
        ['files', 'git', 'sessions'].includes(capability),
      ) &&
      component.parameters['worktree']?.editor !== 'worktree'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['parameters', 'worktree'],
        message: 'File, Git and session operations require an explicit worktree parameter',
      });
  });
export type HuddleComponent = z.infer<typeof huddleComponentSchema>;
