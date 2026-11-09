import { huddleSecretReferenceSchema } from '../../api/huddle/contracts.js';
import type { HuddleComponent } from '../../api/huddle/components.js';
import type { HuddleDefinition, HuddleDiagnostic } from '../../api/huddle/definitions.js';
import type { HuddleValueSchema } from '../../api/huddle/contracts.js';
import { huddlePortCompatibility, validateHuddleValue } from './values.js';

/** Components are resolved per node from a captured revision, never loaded as code. */
export function validateHuddleGraph(
  definition: HuddleDefinition,
  components: ReadonlyMap<string, HuddleComponent>,
): HuddleDiagnostic[] {
  const diagnostics: HuddleDiagnostic[] = [];
  const add = (
    code: string,
    path: string,
    message: string,
    extra: Partial<HuddleDiagnostic> = {},
  ) => {
    if (diagnostics.length < 512)
      diagnostics.push({ severity: 'error', code, path, message, ...extra });
  };
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, number>();
  const forward = new Map<string, string[]>();
  const indegrees = new Map(definition.nodes.map((node) => [node.id, 0]));
  const seenNodes = new Set<string>();
  let triggers = 0;
  for (const [index, node] of definition.nodes.entries()) {
    const path = `/nodes/${index}`;
    if (seenNodes.has(node.id))
      add('duplicate_node', `${path}/id`, `Duplicate node ${node.id}`, { node: node.id });
    seenNodes.add(node.id);
    const component = components.get(node.id);
    if (!component) {
      add('missing_component', `${path}/source`, 'Component could not be resolved', {
        node: node.id,
      });
      continue;
    }
    if (
      node.source.kind === 'builtin' &&
      (node.source.component !== component.id || node.source.version !== component.version)
    )
      add(
        'component_version',
        `${path}/source`,
        'Resolved component does not match its pinned identity',
        { node: node.id },
      );
    if (component.category === 'trigger') triggers++;
    for (const [name, parameter] of Object.entries(component.parameters)) {
      if (
        parameter.default !== undefined &&
        validateHuddleValue(parameter.schema, parameter.default).length
      )
        add(
          'invalid_default',
          `${path}/parameters/${name}`,
          'Component default violates its contract',
          { node: node.id },
        );
      const binding = node.parameters[name];
      if (!binding) {
        if (parameter.required && parameter.default === undefined)
          add('missing_parameter', `${path}/parameters/${name}`, `Set ${name} explicitly`, {
            node: node.id,
          });
        continue;
      }
      if (binding.kind === 'literal') {
        if (
          parameter.editor === 'secret' &&
          !huddleSecretReferenceSchema.safeParse(binding.value).success
        )
          add(
            'secret_reference',
            `${path}/parameters/${name}`,
            'Choose a private integration reference, not a secret value',
            { node: node.id },
          );
        for (const issue of validateHuddleValue(parameter.schema, binding.value))
          add('parameter_value', `${path}/parameters/${name}${issue.path}`, issue.message, {
            node: node.id,
          });
      } else {
        const variable = definition.variables[binding.name];
        if (!variable)
          add(
            'missing_variable',
            `${path}/parameters/${name}`,
            `Unknown variable ${binding.name}`,
            { node: node.id },
          );
        else {
          if (
            variable.editor !== parameter.editor &&
            ['secret', 'worktree', 'account', 'session', 'project', 'agent'].includes(
              parameter.editor,
            )
          )
            add(
              'binding_kind',
              `${path}/parameters/${name}`,
              `Expected a ${parameter.editor} variable`,
              { node: node.id },
            );
          if (huddlePortCompatibility(variable.schema, parameter.schema) === 'incompatible')
            add(
              'binding_type',
              `${path}/parameters/${name}`,
              'Variable and parameter types are incompatible',
              { node: node.id },
            );
        }
      }
    }
    for (const name of Object.keys(node.parameters)) {
      if (!Object.hasOwn(component.parameters, name))
        add(
          'unknown_parameter',
          `${path}/parameters/${name}`,
          'Parameter is not declared by the component',
          { node: node.id },
        );
    }
    if (
      component.capabilities.some((capability) =>
        ['files', 'git', 'sessions'].includes(capability),
      ) &&
      !node.parameters['worktree']
    )
      add(
        'worktree_required',
        `${path}/parameters/worktree`,
        'Declare a literal or variable worktree; there is no cwd fallback',
        { node: node.id },
      );
  }
  for (const [name, variable] of Object.entries(definition.variables)) {
    if (variable.default !== undefined) {
      for (const issue of validateHuddleValue(variable.schema, variable.default))
        add('variable_default', `/variables/${name}/default${issue.path}`, issue.message);
    }
  }
  if (!triggers) add('trigger_required', '/nodes', 'Add a trigger before starting this huddle');

  const seenEdges = new Set<string>();
  const routes = new Set<string>();
  for (const [index, edge] of definition.edges.entries()) {
    const path = `/edges/${index}`;
    const extra = { edge: edge.id };
    if (seenEdges.has(edge.id))
      add('duplicate_edge', `${path}/id`, `Duplicate edge ${edge.id}`, extra);
    seenEdges.add(edge.id);
    const route = `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`;
    if (routes.has(route)) add('duplicate_route', path, 'This connection already exists', extra);
    routes.add(route);
    const source = components.get(edge.from.node)?.outputs[edge.from.port];
    const targetComponent = components.get(edge.to.node);
    const target = targetComponent?.inputs[edge.to.port];
    if (!nodes.has(edge.from.node) || !source)
      add('output_missing', `${path}/from`, 'Source node/output does not exist', extra);
    if (!nodes.has(edge.to.node) || !target)
      add('input_missing', `${path}/to`, 'Destination node/input does not exist', extra);
    if (!source || !target) continue;
    const compatibility = huddlePortCompatibility(source.schema, target.schema);
    if (compatibility !== 'compatible')
      add(
        compatibility === 'incompatible' ? 'port_type' : 'runtime_validation',
        path,
        compatibility === 'incompatible'
          ? 'Ports have incompatible types'
          : 'Compatibility will be checked against each emitted value',
        { ...extra, severity: compatibility === 'incompatible' ? 'error' : 'warning' },
      );
    const input = `${edge.to.node}.${edge.to.port}`;
    const key = `${input}:${edge.feedback ? 'feedback' : 'forward'}`;
    incoming.set(key, (incoming.get(key) ?? 0) + 1);
    if (incoming.get(key)! > 1 && targetComponent?.activation !== 'any')
      add(
        'ambiguous_input',
        `${path}/to`,
        'Use an explicit merge node for alternative sources',
        extra,
      );
    if (edge.feedback) {
      if (target.scope === 'execution')
        add(
          'feedback_execution_input',
          `${path}/to`,
          'Feedback cannot replace an execution input',
          extra,
        );
      let guard: HuddleValueSchema | undefined = source.schema;
      for (const property of edge.feedback.while.path) guard = guard?.properties?.[property];
      if (guard?.type !== 'boolean')
        add(
          'feedback_condition',
          `${path}/feedback/while`,
          'Feedback requires a declared boolean output property',
          extra,
        );
    } else {
      forward.set(edge.from.node, [...(forward.get(edge.from.node) ?? []), edge.to.node]);
      indegrees.set(edge.to.node, (indegrees.get(edge.to.node) ?? 0) + 1);
    }
  }
  for (const [index, node] of definition.nodes.entries()) {
    for (const [port, contract] of Object.entries(components.get(node.id)?.inputs ?? {})) {
      if (
        contract.required &&
        !incoming.has(`${node.id}.${port}:forward`) &&
        !incoming.has(`${node.id}.${port}:feedback`)
      )
        add(
          'unconnected_input',
          `/nodes/${index}/inputs/${port}`,
          'Required input is not connected',
          { node: node.id },
        );
    }
  }
  const ready = [...indegrees].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.pop()!;
    visited++;
    for (const next of forward.get(id) ?? []) {
      const count = indegrees.get(next)! - 1;
      indegrees.set(next, count);
      if (count === 0) ready.push(next);
    }
  }
  if (visited !== nodes.size)
    add('unbounded_cycle', '/edges', 'Every cycle needs an explicit bounded feedback edge');
  const reachable = new Set(
    definition.nodes
      .filter((node) => components.get(node.id)?.category === 'trigger')
      .map((node) => node.id),
  );
  const pending = [...reachable];
  const outgoing = new Map<string, string[]>();
  for (const edge of definition.edges)
    outgoing.set(edge.from.node, [...(outgoing.get(edge.from.node) ?? []), edge.to.node]);
  while (pending.length) {
    for (const next of outgoing.get(pending.pop()!) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        pending.push(next);
      }
    }
  }
  for (const [index, node] of definition.nodes.entries()) {
    if (!reachable.has(node.id))
      add('unreachable_node', `/nodes/${index}`, 'Node cannot receive an event from a trigger', {
        node: node.id,
      });
  }
  return diagnostics;
}
