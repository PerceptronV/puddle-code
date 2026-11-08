import {
  huddleExecutionMcpTools,
  huddleExecutionToolSchemas,
  huddleToolExecutionCommandSchema,
} from '@puddle/shared';
import type { HuddleExecutionClient } from './client.js';

export function executionTools(client?: HuddleExecutionClient) {
  if (!client?.supported) return [];
  return huddleExecutionMcpTools
    .filter((tool) => tool.action !== 'observe-readout' || client.readoutObservation)
    .map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }));
}
export async function callHuddleExecutionTool(
  client: HuddleExecutionClient | undefined,
  name: string,
  args: unknown,
) {
  const tool = huddleExecutionMcpTools.find((tool) => tool.name === name);
  if (!client?.supported || !tool)
    throw new Error('Huddle runtime tool is unavailable on this connection');
  // Validate before adding our discriminator: callers cannot smuggle an action override.
  const parsed = huddleExecutionToolSchemas[tool.action].parse(args);
  return client.execute(huddleToolExecutionCommandSchema.parse({ ...parsed, action: tool.action }));
}
