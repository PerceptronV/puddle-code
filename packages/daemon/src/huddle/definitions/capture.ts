import { lstat, realpath } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import {
  HUDDLE_LIMITS,
  huddleComponentSchema,
  huddleDefinitionSchema,
  huddleIdSchema,
  huddleLayoutSchema,
  validateHuddleGraph,
  type HuddleComponent,
  type HuddleDefinition,
  type HuddleDiagnostic,
  type HuddleLayout,
} from '@puddle/shared';
import { checkedHuddlePath, readHuddleFile } from './files.js';
import { huddleRevisionDigest } from './revision.js';

export interface HuddleDefinitionSnapshot {
  format: 1;
  digest: string;
  definition: HuddleDefinition;
  layout?: HuddleLayout;
  files: Record<string, string>;
  components: Record<string, HuddleComponent>;
  diagnostics: HuddleDiagnostic[];
}

/** Capture one registered worktree's definition; callers own profile/worktree authority. */
export async function captureHuddleDefinition(
  worktree: string,
  id: string,
  builtins: ReadonlyMap<string, HuddleComponent> = new Map(),
): Promise<HuddleDefinitionSnapshot> {
  huddleIdSchema.parse(id);
  const canonicalWorktree = await realpath(worktree);
  const root = await checkedHuddlePath(canonicalWorktree, `.puddle/huddle/${id}`);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error('Huddle definition root must be a directory');
  const files = new Map<string, string>();
  let bytes = 0;
  const capture = async (path: string) => {
    path = path.replace(/^\.\//, '');
    if (files.has(path)) return files.get(path)!;
    if (files.size >= HUDDLE_LIMITS.files) throw new Error('Huddle source file limit exceeded');
    const text = await readHuddleFile(root, path);
    bytes += Buffer.byteLength(text);
    if (bytes > HUDDLE_LIMITS.bundleBytes) throw new Error('Huddle source bundle limit exceeded');
    files.set(path, text);
    return text;
  };
  const raw: unknown = JSON.parse(await capture('huddle.json'));
  const definition = huddleDefinitionSchema.parse(raw);
  if (definition.id !== id) throw new Error('Huddle manifest id must match its directory name');
  let layout: HuddleLayout | undefined;
  try {
    layout = huddleLayoutSchema.parse(JSON.parse(await capture('layout.json')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const diagnostics: HuddleDiagnostic[] = [];
  const components = new Map<string, HuddleComponent>();
  for (const [index, node] of definition.nodes.entries()) {
    if (node.source.kind === 'builtin') {
      const component = builtins.get(`${node.source.component}@${node.source.version}`);
      if (component) components.set(node.id, huddleComponentSchema.parse(component));
      continue;
    }
    try {
      const component = huddleComponentSchema.parse(
        JSON.parse(await capture(node.source.manifest)),
      );
      if (!component.entry) throw new Error('A local component needs an explicit entry point');
      const directory = dirname(node.source.manifest);
      const paths = [component.entry, ...component.dependencies];
      const dependencies = new Set<string>();
      for (const path of paths) {
        const relativePath = posix.join(directory, path);
        if (dependencies.has(relativePath)) throw new Error('Duplicate component dependency');
        dependencies.add(relativePath);
        await capture(relativePath);
      }
      components.set(node.id, component);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'component_invalid',
        node: node.id,
        path: `/nodes/${index}/source`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  diagnostics.push(...validateHuddleGraph(definition, components));
  if (layout) {
    const ids = new Set(definition.nodes.map((node) => node.id));
    for (const id of Object.keys(layout.nodes)) {
      if (!ids.has(id))
        diagnostics.push({
          severity: 'warning',
          code: 'layout_node_missing',
          path: `/layout/nodes/${id}`,
          message: 'Layout position refers to a removed node',
        });
    }
  }
  // Recheck captured inputs before publishing a revision; never silently combine edits.
  for (const [path, captured] of files) {
    if ((await readHuddleFile(root, path)) !== captured)
      throw new Error(`Huddle source changed during capture: ${path}`);
  }
  const currentRoot = await lstat(
    await checkedHuddlePath(canonicalWorktree, `.puddle/huddle/${id}`),
  );
  if (currentRoot.ino !== rootStat.ino || currentRoot.dev !== rootStat.dev)
    throw new Error('Huddle definition directory changed during capture');
  const contents = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)));
  const contracts = Object.fromEntries([...components].sort(([a], [b]) => a.localeCompare(b)));
  const digest = huddleRevisionDigest(contents, contracts);
  return {
    format: 1,
    digest,
    definition,
    ...(layout ? { layout } : {}),
    files: contents,
    components: contracts,
    diagnostics,
  };
}
