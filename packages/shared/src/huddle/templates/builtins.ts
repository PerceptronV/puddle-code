import { huddleComponentSchema } from '../../api/huddle/components.js';
import { coreHuddleComponents, huddleResultReadout } from '../components/core.js';

/** The copied adapter is ordinary source; host observation remains a declared runtime service. */
export function huddleBuiltinCopyFiles(reference: { component: string; version: number }) {
  const builtin = coreHuddleComponents.get(`${reference.component}@${reference.version}`);
  if (!builtin || (builtin.category !== 'trigger' && builtin.id !== huddleResultReadout.id))
    throw new Error('Unknown built-in component copy');
  const trigger = builtin.category === 'trigger';
  const component = huddleComponentSchema.parse({
    ...builtin,
    id: builtin.id.replace(/^puddle\./, 'project.'),
    entry: './run.ts',
    ...(trigger
      ? { hostTrigger: reference }
      : {
          readout: { idempotent: true, reconciliation: 'none', cancellation: 'none' },
        }),
  });
  const source = trigger
    ? `import { HuddleNode } from 'puddlang/huddle';

// The runtime supplies durable ${builtin.title} events using node.json's hostTrigger.
// Configure its source through node settings; customize event data or routing here.
export default HuddleNode({
  contract: './node.json',
  async run({ inputs, parameters, emit, signal }) {
    signal.throwIfAborted();
    // Add settings to node.json to expose them as parameters in the inspector.
    await emit('event', inputs.event!);
    return {};
  },
});
`
    : `import { HuddleReadout } from 'puddlang/huddle';

// Input is retained in this node's execution history, like the built-in Result.
export default HuddleReadout({
  contract: './node.json',
  async deliver(context, delivery) {
    context.signal.throwIfAborted();
    return { status: 'delivered', receipt: { delivery: delivery.id }, outputs: {} };
  },
});
`;
  return {
    component,
    files: {
      'run.ts': source,
      'node.json': JSON.stringify(component, null, 2) + '\n',
    },
  };
}
