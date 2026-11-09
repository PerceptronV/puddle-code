import {
  huddleToolCreateSchema,
  huddleToolDuplicateSchema,
  huddleToolDefinitionSchema,
  huddleToolValidateSchema,
  huddleToolLocationSchema,
} from '@puddle/shared';
import type { HuddleClient } from './client.js';

export async function callHuddleTool(
  client: HuddleClient | undefined,
  name: string,
  args: unknown,
) {
  if (!client?.supported) throw new Error('Huddle source tools are unavailable on this connection');
  switch (name) {
    case 'huddle_list':
      return client.list(huddleToolLocationSchema.parse(args));
    case 'huddle_inspect':
      return client.inspect(huddleToolDefinitionSchema.parse(args));
    case 'huddle_validate':
      return client.validate(huddleToolValidateSchema.parse(args));
    case 'huddle_create':
      return client.create(huddleToolCreateSchema.parse(args));
    case 'huddle_duplicate':
      return client.duplicate(huddleToolDuplicateSchema.parse(args));
    case 'huddle_open':
      return client.open(huddleToolDefinitionSchema.parse(args));
    default:
      throw new Error('Unknown huddle tool');
  }
}
