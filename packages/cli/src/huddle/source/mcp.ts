import { huddleToolDefinitionSchema, huddleToolSaveSourceSchema } from '@puddle/shared';
import type { HuddleSourceClient } from './client.js';

export async function callHuddleSourceTool(
  client: HuddleSourceClient | undefined,
  name: string,
  args: unknown,
) {
  if (!client?.supported)
    throw new Error('Huddle captured source tools are unavailable on this connection');
  if (name === 'huddle_source') return client.read(huddleToolDefinitionSchema.parse(args));
  if (name === 'huddle_save_source') return client.save(huddleToolSaveSourceSchema.parse(args));
  throw new Error('Unknown huddle source tool');
}
