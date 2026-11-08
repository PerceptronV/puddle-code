import { huddleComponentSchema } from '../../api/huddle/components.js';

const nullableText = { type: ['string', 'null'] as const };
export const gitHuddleTrigger = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.git',
  version: 1,
  category: 'trigger',
  title: 'Git',
  capabilities: ['git'],
  parameters: {
    worktree: { title: 'Worktree', schema: { type: 'string' }, editor: 'worktree' },
    repository: {
      title: 'Repository directory',
      description: 'Relative Git repository root inside the selected worktree. Use . for its root.',
      schema: { type: 'string' },
      editor: 'text',
      default: '.',
    },
    refs: {
      title: 'Ref globs',
      description:
        'JSON list under refs/heads, refs/tags or refs/remotes. Use [] to observe only HEAD.',
      schema: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      editor: 'json',
      default: ['refs/heads/**', 'refs/tags/**'],
    },
    head: {
      title: 'Observe worktree HEAD',
      schema: { type: 'boolean' },
      editor: 'boolean',
      default: true,
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
        'Observe net ref changes after missed notifications; this is not a complete commit history.',
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
                ref: { type: 'string' },
                oldOid: nullableText,
                newOid: nullableText,
                oldTarget: nullableText,
                newTarget: nullableText,
              },
              required: ['ref', 'oldOid', 'newOid', 'oldTarget', 'newTarget'],
            },
          },
          repository: { type: 'string' },
          reconciled: { type: 'boolean', enum: [true] },
          observedAt: { type: 'string' },
          batch: { type: 'integer', minimum: 1 },
          final: { type: 'boolean' },
        },
        required: ['changes', 'repository', 'reconciled', 'observedAt', 'batch', 'final'],
      },
    },
  },
});
