import { z } from 'zod';
export const huddleAuthoringRequestSchema = z.strictObject({
  path: z.string().min(1).max(256).optional(),
});
export const huddleAuthoringMcpTool = {
  name: 'huddle_authoring',
  description:
    'List bundled-client huddle authoring schemas, wrapper types, templates and fake fixtures; pass an exact listed path to read one asset. No project/host reads, writes or execution. The labelled client version is not evidence of target-host support; validate source on that host.',
  inputSchema: z.toJSONSchema(huddleAuthoringRequestSchema),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
