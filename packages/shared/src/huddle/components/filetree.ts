import { huddleComponentSchema } from '../../api/huddle/components.js';

export const filetreeHuddleTrigger = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.filetree',
  version: 1,
  category: 'trigger',
  title: 'Filetree',
  capabilities: ['files'],
  parameters: {
    worktree: { title: 'Worktree', schema: { type: 'string' }, editor: 'worktree' },
    directory: {
      title: 'Directory',
      description:
        'Relative to the selected worktree. Use . for its root. Symlinks are not followed.',
      schema: { type: 'string' },
      editor: 'text',
      default: '.',
    },
    include: {
      title: 'Include globs',
      description:
        'JSON list of globs relative to Directory. Hidden files require an explicit dot glob.',
      schema: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
      editor: 'json',
      default: ['**/*'],
    },
    exclude: {
      title: 'Exclude globs',
      description:
        'JSON list relative to Directory. Git metadata and .puddle/huddle are always excluded.',
      schema: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      editor: 'json',
      default: ['**/node_modules/**'],
    },
    outputPaths: {
      title: 'Output paths',
      description:
        'JSON list of files/directories relative to the worktree that this graph writes. Excluded to prevent feedback.',
      schema: { type: 'array', items: { type: 'string' }, maxItems: 32 },
      editor: 'json',
      default: [],
    },
    debounceMs: {
      title: 'Debounce (milliseconds)',
      schema: { type: 'integer', minimum: 50, maximum: 10000 },
      editor: 'duration',
      default: 250,
    },
    reconcileMs: {
      title: 'Reconcile (milliseconds)',
      description:
        'Bounded rescan interval for missed notifications. Events describe net changes, not a complete edit history.',
      schema: { type: 'integer', minimum: 1000, maximum: 300000 },
      editor: 'duration',
      default: 30000,
    },
  },
  outputs: {
    event: {
      emission: 'event',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changes: {
            type: 'array',
            maxItems: 64,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                kind: { type: 'string', enum: ['create', 'change', 'remove'] },
              },
              required: ['path', 'kind'],
            },
          },
          reconciled: { type: 'boolean', enum: [true] },
          observedAt: { type: 'string' },
          batch: { type: 'integer', minimum: 1 },
          final: { type: 'boolean' },
        },
        required: ['changes', 'reconciled', 'observedAt', 'batch', 'final'],
      },
    },
  },
});
