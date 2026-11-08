import type { HuddleValueSchema } from '../../../api/huddle/contracts.js';

export const agentHandleValueSchema: HuddleValueSchema = {
  type: 'object',
  properties: { runtime_id: { type: 'string' }, session_id: { type: 'string' } },
  required: ['runtime_id', 'session_id'],
  additionalProperties: false,
};
