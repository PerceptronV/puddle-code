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
    trigger: z.strictObject({ resume: z.enum(['continue', 'fresh']) }).optional(),
    readout: z
      .strictObject({
        idempotent: z.boolean(),
        reconciliation: z.enum(['none', 'observe']),
        cancellation: z.enum(['none', 'signal']),
      })
      .optional(),
    appearance: huddleAppearanceSchema.optional(),
    entry: huddleRelativePathSchema.optional(),
    dependencies: z.array(huddleRelativePathSchema).max(HUDDLE_LIMITS.files).default([]),
  })
  .superRefine((component, ctx) => {
    const retained = Object.entries(component.inputs).filter(
      ([, port]) => port.scope === 'execution',
    );
    for (const [name, port] of retained) {
      if (!port.required || component.activation !== 'all')
        ctx.addIssue({
          code: 'custom',
          path: ['inputs', name, 'scope'],
          message: 'Execution inputs must be required and use all-input activation',
        });
    }
    if (
      retained.length &&
      !Object.values(component.inputs).some((port) => port.required && port.scope !== 'execution')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['inputs'],
        message: 'Execution inputs need a required activation input',
      });
    for (const [name, port] of Object.entries(component.outputs)) {
      if (port.scope !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', name, 'scope'],
          message: 'Input scope cannot be declared on an output',
        });
    }
    if (component.category === 'trigger' && component.entry && !component.trigger)
      ctx.addIssue({
        code: 'custom',
        path: ['trigger'],
        message: 'Local triggers must declare resume behaviour',
      });
    if (component.trigger && component.category !== 'trigger')
      ctx.addIssue({
        code: 'custom',
        path: ['trigger'],
        message: 'Subscription policy belongs to a trigger',
      });
    if (component.category === 'readout' && component.entry && !component.readout)
      ctx.addIssue({
        code: 'custom',
        path: ['readout'],
        message: 'Local readouts must declare delivery support',
      });
    if (component.readout && component.category !== 'readout')
      ctx.addIssue({
        code: 'custom',
        path: ['readout'],
        message: 'Delivery support belongs to a readout',
      });
    if (
      component.category === 'readout' &&
      Object.values(component.outputs).some((port) => port.emission !== 'completion')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['outputs'],
        message: 'Readout outputs require confirmed delivery',
      });
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
