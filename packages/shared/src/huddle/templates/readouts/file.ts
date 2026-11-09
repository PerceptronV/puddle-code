import { huddleComponentSchema } from '../../../api/huddle/components.js';
import { fileReportSource } from './file-source.js';

const receipt = {
  type: 'object' as const,
  properties: {
    worktree: { type: 'string' as const },
    path: { type: 'string' as const },
    sha256: { type: 'string' as const },
    bytes: { type: 'integer' as const, minimum: 0 },
  },
  required: ['worktree', 'path', 'sha256', 'bytes'],
  additionalProperties: false,
};
export const fileReportComponent = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.readout.file',
  version: 1,
  category: 'readout',
  title: 'Write report',
  description:
    'Create a report in the selected worktree. Existing files are never overwritten. Add the report directory to any Filetree trigger’s output exclusions.',
  inputs: { value: { schema: {} } },
  outputs: { completed: { schema: receipt } },
  parameters: {
    worktree: { title: 'Worktree', schema: { type: 'string', minLength: 1 }, editor: 'worktree' },
    path: {
      title: 'Report path',
      description:
        'Relative to the worktree. Supports {{huddleId}}, {{executionId}} and {{invocationId}}. Missing parent directories are created; Git and huddle metadata paths are excluded.',
      schema: { type: 'string', minLength: 1, maxLength: 1024 },
      editor: 'text',
      default: 'reports/{{huddleId}}/{{invocationId}}.md',
    },
    format: {
      title: 'Content format',
      description:
        'Text requires a string and preserves it exactly. JSON formats any incoming value with a trailing newline. Maximum 256 KiB.',
      schema: { type: 'string', enum: ['text', 'json'] },
      editor: 'enum',
      default: 'text',
    },
  },
  capabilities: ['files'],
  readout: { idempotent: false, reconciliation: 'observe', cancellation: 'none' },
  entry: './run.ts',
  dependencies: ['./file.ts'],
});
export const fileReportFiles = {
  'node.json': JSON.stringify(fileReportComponent, null, 2) + '\n',
  'run.ts': `import { HuddleReadout } from 'puddlang/huddle';
import { report } from './file.ts';

export default HuddleReadout({
  contract: './node.json',
  async deliver(context, delivery) { return report(context, delivery, false); },
  async observe(context, delivery) { return report(context, delivery, true); },
});
`,
  'file.ts': fileReportSource,
};
