import {
  huddlePlacementMcpTools,
  huddleToolPlacementSchema,
  huddleToolPlacementCommandSchema,
} from '@puddle/shared';
import type { HuddlePlacementClient } from './client.js';

export function placementTools(client?: HuddlePlacementClient) {
  if (!client?.supported) return [];
  return huddlePlacementMcpTools.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    annotations,
  }));
}

export async function callHuddlePlacementTool(
  client: HuddlePlacementClient | undefined,
  name: string,
  args: unknown,
) {
  const tool = huddlePlacementMcpTools.find((candidate) => candidate.name === name);
  if (!client?.supported || !tool)
    throw new Error('Huddle placement tool is unavailable on this connection');
  const parsed = huddleToolPlacementSchema.parse(args);
  return client.execute(huddleToolPlacementCommandSchema.parse({ ...parsed, action: tool.action }));
}
