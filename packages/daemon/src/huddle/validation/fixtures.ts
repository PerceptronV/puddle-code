import {
  huddleContractFixtureSchema,
  huddleHostTrigger,
  validateHuddleValue,
  type HuddleDiagnostic,
} from '@puddle/shared';
import { validatePorts, validateParameters } from '../../puddlang/huddle/values.js';
import type { HuddleDefinitionSnapshot } from '../definitions/capture.js';

/** Samples check declared values, not whether executing a module would produce them. */
export function validateHuddleFixture(
  snapshot: HuddleDefinitionSnapshot,
  text: string,
  path: string,
) {
  const fixture = huddleContractFixtureSchema.parse(JSON.parse(text));
  const diagnostics: HuddleDiagnostic[] = [];
  for (const [index, sample] of fixture.cases.entries()) {
    const node = snapshot.definition.nodes.find((item) => item.id === sample.node);
    const component = snapshot.components[sample.node];
    const check = (field: string, action: () => void) => {
      try {
        action();
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          code: 'fixture_value',
          node: sample.node,
          path: `/fixtures/${path}/cases/${index}/${field}`,
          message:
            `${sample.name}: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              4096,
            ),
        });
      }
    };
    if (!node || !component) {
      check('node', () => {
        throw new Error('Fixture names an unresolved node');
      });
      continue;
    }
    if (sample.inputs)
      check('inputs', () =>
        validatePorts(
          component.hostTrigger ? huddleHostTrigger(node, component)!.outputs : component.inputs,
          sample.inputs!,
          'input',
          component.activation,
        ),
      );
    if (sample.parameters)
      check('parameters', () => validateParameters(component, sample.parameters!));
    if (sample.outputs)
      check('outputs', () =>
        validatePorts(
          component.category === 'readout'
            ? component.outputs
            : Object.fromEntries(
                Object.entries(component.outputs).filter(
                  ([, port]) => port.emission === 'completion',
                ),
              ),
          sample.outputs!,
          'output',
        ),
      );
    for (const [emission, value] of (sample.emissions ?? []).entries())
      check(`emissions/${emission}`, () => {
        const contract = component.outputs[value.port];
        const subscription = component.category === 'trigger' && !component.hostTrigger;
        if (
          !contract ||
          (!subscription && contract.emission !== 'event') ||
          component.category === 'readout'
        )
          throw new Error(`Unknown event output: ${value.port}`);
        if (validateHuddleValue(contract.schema, value.value).length)
          throw new Error(`Invalid event value: ${value.port}`);
      });
  }
  return { cases: fixture.cases.length, diagnostics };
}
