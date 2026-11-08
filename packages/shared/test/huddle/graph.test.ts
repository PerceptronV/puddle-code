import { describe, expect, it } from 'vitest';
import { huddleDefinitionSchema } from '../../src/api/huddle/definitions.js';
import { validateHuddleGraph } from '../../src/huddle/validation/graph.js';
import {
  manualComponent,
  manualHuddleFixture,
  resultComponent,
  reviewHuddleFixture,
} from '../helpers/huddle.js';

describe('huddle graph validation', () => {
  it('accepts the manual graph and a bounded two-agent feedback loop', () => {
    expect(
      validateHuddleGraph(
        manualHuddleFixture(),
        new Map([
          ['run', manualComponent],
          ['result', resultComponent],
        ]),
      ),
    ).toEqual([]);
    const { definition, components } = reviewHuddleFixture();
    expect(
      validateHuddleGraph(definition, components).filter((d) => d.severity === 'error'),
    ).toEqual([]);
  });

  it('rejects unbounded cycles and feedback without a typed exit condition', () => {
    const { definition, components } = reviewHuddleFixture();
    definition.edges[2]!.feedback = undefined;
    expect(validateHuddleGraph(definition, components).map((d) => d.code)).toContain(
      'unbounded_cycle',
    );
    definition.edges[2]!.feedback = { maxRounds: 5, while: { path: ['feedback'], equals: false } };
    expect(validateHuddleGraph(definition, components).map((d) => d.code)).toContain(
      'feedback_condition',
    );
    expect(
      huddleDefinitionSchema.safeParse({
        ...definition,
        edges: [{ ...definition.edges[2], feedback: { maxRounds: 0 } }],
      }).success,
    ).toBe(false);
  });

  it('reports missing ports, components, duplicate ids and ambiguous inputs', () => {
    const { definition, components } = reviewHuddleFixture();
    definition.nodes.push({ ...definition.nodes[0]! });
    definition.edges.push({ ...definition.edges[0]! });
    definition.edges[1]!.from.port = 'missing';
    components.delete('reviewer');
    expect(validateHuddleGraph(definition, components).map((d) => d.code)).toEqual(
      expect.arrayContaining([
        'duplicate_node',
        'duplicate_edge',
        'duplicate_route',
        'ambiguous_input',
        'output_missing',
        'missing_component',
      ]),
    );
  });

  it('requires explicit worktree and correctly typed resource variables', () => {
    const { definition, components } = reviewHuddleFixture();
    delete definition.nodes[1]!.parameters['worktree'];
    definition.nodes[2]!.parameters['worktree'] = { kind: 'variable', name: 'reviewer' };
    definition.nodes[2]!.parameters['agent'] = { kind: 'variable', name: 'missing' };
    expect(validateHuddleGraph(definition, components).map((d) => d.code)).toEqual(
      expect.arrayContaining(['worktree_required', 'binding_kind', 'missing_variable']),
    );
  });

  it('validates parameter literals/defaults and pins builtin identities', () => {
    const { definition, components } = reviewHuddleFixture();
    definition.nodes[1]!.parameters['agent'] = { kind: 'literal', value: 15 };
    definition.variables['worktree']!.default = false;
    definition.nodes[0]!.source = {
      kind: 'builtin',
      component: 'puddle.trigger.manual',
      version: 2,
    };
    expect(validateHuddleGraph(definition, components).map((d) => d.code)).toEqual(
      expect.arrayContaining(['parameter_value', 'variable_default', 'component_version']),
    );
  });

  it('keeps blank drafts representable but refuses activation without a trigger', () => {
    const blank = huddleDefinitionSchema.parse({
      format: 1,
      id: manualHuddleFixture().id,
      name: 'Blank',
      nodes: [],
      edges: [],
    });
    expect(validateHuddleGraph(blank, new Map()).map((d) => d.code)).toEqual(['trigger_required']);
  });
});
