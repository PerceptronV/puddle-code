import {
  canonicalHuddleJson,
  huddleComponentSchema,
  huddleDefinitionSchema,
  huddleInboxRecordSchema,
  huddleRevisionSchema,
  validateHuddleGraph,
  validateHuddleValue,
  type HuddleComponent,
  type HuddleDefinition,
  type HuddleJson,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { HuddleStateDatabase } from '../state/database.js';
import { HuddleExecutions } from '../state/executions.js';
import { HuddleInvocations } from '../state/invocations.js';
import { HuddleJoins } from '../state/joins.js';

export class HuddleFeedbackLimitError extends Error {
  constructor(
    readonly edge: string,
    readonly maxRounds: number,
  ) {
    super(
      `Feedback edge ${edge} reached its ${maxRounds}-round limit without satisfying its exit condition`,
    );
    this.name = 'HuddleFeedbackLimitError';
  }
}

interface CausalOutput {
  executionId: string;
  activation: string;
  iteration: number;
  node: string;
  port: string;
  value: HuddleJson;
  delivery: string;
}

/** Durable graph admission only; worker launch and owner scheduling compose this boundary. */
export class HuddleGraphRouting {
  private readonly definition: HuddleDefinition;
  private readonly components: Map<string, HuddleComponent>;
  private readonly joins: HuddleJoins;
  private readonly revision: string;

  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
    private readonly invocations: HuddleInvocations,
    revision: string,
    definition: HuddleDefinition,
    components: ReadonlyMap<string, HuddleComponent>,
  ) {
    this.revision = huddleRevisionSchema.parse(revision);
    this.definition = huddleDefinitionSchema.parse(definition);
    if (this.definition.id !== db.identity.huddleId)
      throw new Error('Graph belongs to another huddle');
    this.components = new Map(
      this.definition.nodes.map((node) => [
        node.id,
        huddleComponentSchema.parse(components.get(node.id)),
      ]),
    );
    const invalid = validateHuddleGraph(this.definition, this.components).find(
      (item) => item.severity === 'error',
    );
    if (invalid) throw new Error(`Invalid huddle graph: ${invalid.message}`);
    this.joins = new HuddleJoins(db, invocations);
  }

  /** Start and seed all trigger fan-out in one transaction; repeat requests only observe. */
  start(executionId: string, now = Date.now()): boolean {
    return this.db.atomic(() => {
      const execution = this.executions.get(executionId);
      if (execution.revision !== this.revision)
        throw new Error('Execution belongs to another revision');
      if (this.db.get('graph-starts', executionId)) return false;
      if (canonicalHuddleJson(execution.limits) !== canonicalHuddleJson(this.definition.execution))
        throw new Error('Execution limits differ from the captured graph');
      const inbox = huddleInboxRecordSchema.parse(
        JSON.parse(this.db.get('inbox', execution.eventKey)!.body),
      );
      const event = inbox.event;
      const component = this.components.get(event.source.node);
      if (
        component?.category !== 'trigger' ||
        component.id !== event.source.component ||
        component.version !== event.source.version
      )
        throw new Error('Event source differs from its captured trigger');
      this.checkOutput(event.source.node, event.port, event.data);
      this.executions.start(executionId, now);
      this.forward(
        {
          executionId,
          activation: digest(`root:${executionId}`),
          iteration: 0,
          node: event.source.node,
          port: event.port,
          value: event.data,
          delivery: execution.eventKey,
        },
        now,
      );
      this.db.put('graph-starts', executionId, executionId, 'started', { revision: this.revision });
      return true;
    });
  }

  route(invocationId: string, sequence: number, now = Date.now()): boolean {
    const invocation = this.invocations.get(invocationId);
    if (invocation.revision !== this.revision)
      throw new Error('Invocation belongs to another revision');
    return this.invocations.route(
      invocationId,
      sequence,
      (emission) => {
        if (!['running', 'completed'].includes(invocation.state))
          throw new Error('Cannot route pending output from an unsuccessful invocation');
        const contract = this.checkOutput(emission.node, emission.port, emission.value);
        if (contract.emission !== emission.kind)
          throw new Error('Emission kind differs from its port contract');
        // Completion ports share their input cohort; each explicit event emission starts a new one.
        const delivery = digest(`${invocationId}:${sequence}`);
        this.forward(
          {
            executionId: emission.executionId,
            node: emission.node,
            port: emission.port,
            value: emission.value,
            delivery,
            iteration: invocation.iteration,
            activation:
              emission.kind === 'event' ? digest(`event:${delivery}`) : invocation.activation,
          },
          now,
        );
      },
      now,
    );
  }

  private checkOutput(node: string, port: string, value: HuddleJson) {
    const contract = this.components.get(node)?.outputs[port];
    if (!contract || validateHuddleValue(contract.schema, value).length)
      throw new Error(`Invalid graph output: ${node}.${port}`);
    return contract;
  }

  private forward(output: CausalOutput, now: number): void {
    for (const edge of this.definition.edges) {
      if (edge.from.node !== output.node || edge.from.port !== output.port) continue;
      let activation = output.activation;
      let iteration = output.iteration;
      if (edge.feedback) {
        let condition: HuddleJson | undefined = output.value;
        for (const property of edge.feedback.while.path) {
          condition =
            condition !== null &&
            typeof condition === 'object' &&
            !Array.isArray(condition) &&
            Object.hasOwn(condition, property)
              ? condition[property]
              : undefined;
        }
        if (typeof condition !== 'boolean')
          throw new Error(`Feedback condition is missing or invalid: ${edge.id}`);
        if (condition !== edge.feedback.while.equals) continue;
        if (iteration + 1 >= edge.feedback.maxRounds)
          throw new HuddleFeedbackLimitError(edge.id, edge.feedback.maxRounds);
        iteration++;
        activation = digest(
          canonicalHuddleJson({ feedback: edge.id, previous: activation, iteration }),
        );
      }
      const component = this.components.get(edge.to.node)!;
      const port = component.inputs[edge.to.port]!;
      if (validateHuddleValue(port.schema, output.value).length)
        throw new Error(`Invalid graph input: ${edge.to.node}.${edge.to.port}`);
      // Explicit alternatives each produce their own activation, never a latest-value join.
      if (component.activation === 'any')
        activation = digest(
          canonicalHuddleJson({ merge: edge.id, delivery: output.delivery, activation }),
        );
      this.joins.deliver(
        {
          executionId: output.executionId,
          revision: this.revision,
          node: edge.to.node,
          activation,
          iteration,
        },
        edge.to.port,
        output.value,
        digest(`${output.delivery}:${edge.id}`),
        component,
        now,
      );
    }
  }
}
