import {
  huddleJsonSchema,
  huddleStartSchema,
  resolveHuddleVariables,
  type HuddleDefinition,
} from '@puddle/shared';

export function initialHuddleVariables(definition: HuddleDefinition) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(definition.variables).flatMap(([name, variable]) =>
        variable.default === undefined ? [] : [[name, variable.default]],
      ),
    ),
    null,
    2,
  );
}
export function parseHuddleVariables(definition: HuddleDefinition, text: string) {
  const variables = huddleStartSchema.shape.variables.parse(JSON.parse(text));
  resolveHuddleVariables(definition, variables);
  return variables;
}
export function parseHuddleInput(text: string) {
  return huddleJsonSchema.parse(JSON.parse(text));
}
