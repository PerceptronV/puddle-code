import { z } from 'zod';
import { huddleComponentSchema } from '../../api/huddle/components.js';
import { huddleDefinitionSchema, huddleLayoutSchema } from '../../api/huddle/definitions.js';
import { huddleValueSchema } from '../../api/huddle/contracts.js';
import { huddleJsonSchema, HUDDLE_LIMITS } from '../../api/huddle/values.js';

/** Editor schemas describe structure; runtime refinements and graph validation remain authoritative. */
export function huddleAuthoringSchemas() {
  const convert = (schema: z.ZodType, io: 'input' | 'output' = 'input') =>
    z.toJSONSchema(schema, {
      io,
      unrepresentable: 'any',
      override: ({ zodSchema, jsonSchema }) => {
        if (zodSchema === huddleJsonSchema) {
          Object.assign(jsonSchema, {
            type: ['null', 'boolean', 'number', 'string', 'array', 'object'],
            $comment: `Runtime additionally enforces ${HUDDLE_LIMITS.valueBytes} UTF-8 bytes, depth ${HUDDLE_LIMITS.valueDepth}, and ${HUDDLE_LIMITS.valueEntries} entries.`,
          });
        } else if (zodSchema === huddleValueSchema && schema !== huddleValueSchema) {
          for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
          Object.assign(jsonSchema, { $ref: 'value-schema.json' });
        } else if (zodSchema._zod.def.type === 'custom') {
          throw new Error('Unrepresented custom authoring schema');
        }
      },
    });
  return {
    'schemas/huddle.json': convert(huddleDefinitionSchema),
    'schemas/component.json': convert(huddleComponentSchema),
    'schemas/layout.json': convert(huddleLayoutSchema),
    'schemas/value-schema.json': convert(huddleValueSchema, 'output'),
  };
}
