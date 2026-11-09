import {
  coreHuddleComponents,
  huddleComponentSchema,
  huddleStarterFiles,
  type HuddleDocument,
} from '@puddle/shared';

/** A directly openable example using the shipped graph and real editable node sources. */
export function previewGraph(document: HuddleDocument, worktree: string) {
  const starter = huddleStarterFiles(
    'review-loop',
    document.definition.id,
    'Two-agent review · Preview',
    worktree,
  );
  starter.layout.nodes = {
    run: { x: 40, y: 80 },
    coder: { x: 360, y: 80 },
    reviewer: { x: 680, y: 80 },
    approved: { x: 360, y: 380 },
    result: { x: 680, y: 380 },
  };
  starter.files['layout.json'] = JSON.stringify(starter.layout, null, 2);
  Object.assign(document, {
    definition: starter.definition,
    layout: starter.layout,
    components: Object.fromEntries(
      starter.definition.nodes.map((node) => [
        node.id,
        node.source.kind === 'local'
          ? huddleComponentSchema.parse(JSON.parse(starter.files[node.source.manifest]!))
          : coreHuddleComponents.get(`${node.source.component}@${node.source.version}`),
      ]),
    ),
  });
  return starter.files;
}
