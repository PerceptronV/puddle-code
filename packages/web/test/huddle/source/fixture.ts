import {
  coreHuddleComponents,
  huddleDefinitionSchema,
  huddleLayoutSchema,
  huddleComponentSchema,
  huddleRevisionContent,
  huddleTextEditSchema,
  type HuddleDocument,
} from '@puddle/shared';
import { sourceHash } from '../../../src/features/huddle/documents/source/revision';

type File = { content: string; mtime: number };
/** Captured source HTTP fixture; no runtime, filesystem or project module execution. */
export function sourceFixture(
  document: HuddleDocument,
  disk: Map<string, File>,
  components: Map<string, File>,
) {
  const id = document.definition.id;
  const root = `.puddle/huddle/${id}/`;
  let lose = false;
  let wait: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const fail = (code: string, status = 409) =>
    Response.json({ error: { code, message: code } }, { status });
  const capture = async () => {
    const files: Record<string, string> = { 'huddle.json': disk.get(id)!.content };
    const definition = huddleDefinitionSchema.parse(JSON.parse(files['huddle.json']!));
    const layout = components.get(`${root}layout.json`);
    if (layout) files['layout.json'] = layout.content;
    const contracts: HuddleDocument['components'] = {};
    for (const node of definition.nodes) {
      if (node.source.kind === 'builtin') {
        const contract = coreHuddleComponents.get(
          `${node.source.component}@${node.source.version}`,
        );
        if (contract) contracts[node.id] = contract;
      } else {
        const manifest = node.source.manifest.replace(/^\.\//, '');
        files[manifest] = components.get(root + manifest)!.content;
        const contract = huddleComponentSchema.parse(JSON.parse(files[manifest]!));
        contracts[node.id] = contract;
        const dir = manifest.slice(0, manifest.lastIndexOf('/') + 1);
        for (const file of [contract.entry, ...contract.dependencies].filter(
          (path): path is string => !!path,
        )) {
          const path = (dir + file)
            .split('/')
            .filter((part) => part !== '.')
            .join('/');
          files[path] = components.get(root + path)!.content;
        }
      }
    }
    Object.assign(document, {
      definition,
      components: contracts,
      layout: layout ? huddleLayoutSchema.parse(JSON.parse(layout.content)) : undefined,
      digest: await sourceHash(huddleRevisionContent(files, contracts)),
    });
    return { document: structuredClone(document), files };
  };
  return {
    async request(method: string, body?: { expected_digest: string; edit: unknown }) {
      try {
        if (method === 'PUT') {
          await wait;
          const before = await capture();
          if (body?.expected_digest !== before.document.digest)
            return fail('huddle_source_changed');
          const edit = huddleTextEditSchema.parse(body.edit);
          const file =
            edit.file === 'huddle.json' ? disk.get(id)! : components.get(root + edit.file);
          const next = { content: edit.content, mtime: (file?.mtime ?? 0) + 1 };
          if (edit.file === 'huddle.json') disk.set(id, next);
          else components.set(root + edit.file, next);
          const saved = await capture();
          if (lose) {
            lose = false;
            throw new TypeError('Synthetic lost save reply');
          }
          return Response.json(saved);
        }
        return Response.json(await capture());
      } catch (error) {
        if (error instanceof TypeError && error.message === 'Synthetic lost save reply')
          throw error;
        return fail('huddle_definition_invalid');
      }
    },
    loseNext() {
      lose = true;
    },
    hold() {
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      wait = undefined;
    },
    script(content: string) {
      components.set(`${root}nodes/review/run.ts`, { content, mtime: 1 });
    },
    invalid() {
      disk.set(id, { content: '{ invalid', mtime: disk.get(id)!.mtime + 1 });
    },
  };
}
