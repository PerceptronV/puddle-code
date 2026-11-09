import { huddleDefinitionSchema, huddleLayoutSchema } from '../../../api/huddle/definitions.js';
import { huddleTemplateFiles } from '../catalogue.js';

export const huddleStarters = [
  {
    id: 'manual',
    title: 'Manual flow',
    description:
      'Run → Transform → Result. Ready for a manual input; edit the script to customise it.',
  },
  {
    id: 'review-loop',
    title: 'Two-agent review',
    description:
      'Choose an existing coder and reviewer in the node settings. They share this worktree and take turns, for at most five rounds.',
  },
] as const;
export type HuddleStarter = (typeof huddleStarters)[number]['id'];

/** Data-only starter publication. Nodes use the ordinary editable template catalogue. */
export function huddleStarterFiles(
  template: HuddleStarter,
  id: string,
  name: string,
  worktree: string,
) {
  const files: Record<string, string> = {};
  const local = (node: string, component: Parameters<typeof huddleTemplateFiles>[0]) => {
    const source = huddleTemplateFiles(component);
    for (const [file, content] of Object.entries(source.files))
      files[`nodes/${node}/${file}`] = content;
    return { id: node, source: { kind: 'local' as const, manifest: `nodes/${node}/node.json` } };
  };
  const run = {
    id: 'run',
    source: { kind: 'builtin', component: 'puddle.trigger.manual', version: 1 },
  };
  const result = {
    id: 'result',
    source: { kind: 'builtin', component: 'puddle.readout.result', version: 1 },
  };
  const edge = (id: string, from: string, port: string, to: string) => ({
    id,
    from: { node: from, port },
    to: { node: to, port: 'value' },
  });
  const review = template === 'review-loop';
  const definition = huddleDefinitionSchema.parse({
    format: 1,
    id,
    name,
    description: review
      ? 'Choose coder and reviewer sessions in this worktree, then Start and Run with a task. Approval exits; five rounds without approval is a visible limit outcome.'
      : 'Run a manual JSON input through an editable transform and inspect its result.',
    nodes: review
      ? [
          run,
          ...(['coder', 'reviewer'] as const).map((node) => ({
            ...local(node, node === 'coder' ? 'prompt-agent' : 'review-agent'),
            parameters: { worktree: { kind: 'literal', value: worktree } },
          })),
          local('approved', 'condition'),
          result,
        ]
      : [run, local('transform', 'transform'), result],
    edges: review
      ? [
          edge('seed', 'run', 'event', 'coder'),
          edge('review', 'coder', 'completed', 'reviewer'),
          {
            ...edge('revise', 'reviewer', 'completed', 'coder'),
            feedback: { maxRounds: 5, while: { path: ['complete'], equals: false } },
          },
          edge('approval', 'reviewer', 'completed', 'approved'),
          edge('result', 'approved', 'matched', 'result'),
        ]
      : [
          edge('input', 'run', 'event', 'transform'),
          edge('output', 'transform', 'completed', 'result'),
        ],
    ...(review
      ? {
          execution: {
            concurrency: 1,
            maxTurns: 10,
            maxAgents: 2,
            maxInvocations: 32,
            timeoutMs: 3600000,
          },
        }
      : {}),
  });
  const layout = huddleLayoutSchema.parse({
    format: 1,
    nodes: Object.fromEntries(
      definition.nodes.map((node, index) => [node.id, { x: index * 320, y: 100 }]),
    ),
  });
  files['huddle.json'] = JSON.stringify(definition, null, 2) + '\n';
  files['layout.json'] = JSON.stringify(layout, null, 2) + '\n';
  files['README.md'] = review
    ? `# Two-agent review\n\nSelect Coder and Reviewer nodes and set each Agent session explicitly. Both nodes\ndeclare the selected definition worktree. Choose two sessions in that worktree so\nthey can inspect the same uncommitted files. No account or agent is chosen for you.\nMissing session bindings are expected validation diagnostics until configured.\n\nSave, Start, then Run with a JSON string describing the task. The coder's completed\nreply feeds the reviewer. Structured feedback returns to the coder while complete\nis false, for at most five rounds/ten turns. Only an approved reply reaches Result;\nexhaustion is a failed limit outcome. Inspect each reply in execution history.\nNo coordinator agent or duplicate completion-trigger subscription is needed.\n\nThe nodes attach to existing agents, never spawn them. Interruption cancels only\nthis huddle's pending asks, using ordinary Puddle controls. Edit the local node\nscripts, prompts and contracts as needed; saving does not activate them.\n`
    : `# Manual flow\n\nSave and Start, then Run with any JSON input. Transform initially returns that\ninput unchanged; Result retains it in execution history. Open Transform's script\nto map the data and update its contract to describe the new output. Save and Apply\nexplicitly to change the active graph. This graph uses no agents or external\nservices and declares no automatic triggers.\n`;
  files['fixtures/input.json'] = review
    ? '"Implement a small change and review it"\n'
    : '{"message":"Hello"}\n';
  return { definition, layout, files };
}
