import { posix } from 'node:path';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import {
  canonicalHuddleJson,
  huddleComponentSchema,
  huddleRelativePathSchema,
  type HuddleWorkerJob,
  type HuddleTriggerWorkerJob,
} from '@puddle/shared';

const prefix = 'puddle-huddle:///';
const normal = (path: string) => huddleRelativePathSchema.parse(path).replace(/^\.\//, '');

/** Validate the complete component closure before evaluating any project module. */
export function checkedWorkerSource(job: HuddleWorkerJob | HuddleTriggerWorkerJob) {
  const manifest = normal(job.manifest);
  const component = job.component;
  if (!component.entry) throw new Error('Worker requires a local executable entry point');
  const trigger = 'subscriptionId' in job;
  if ((component.category === 'trigger' && !component.hostTrigger) !== trigger)
    throw new Error('Trigger worker requires a subscription');
  const readout = 'readout' in job ? job.readout : undefined;
  if ((component.category === 'readout') !== !!readout)
    throw new Error('Readout worker requires its exact delivery envelope');
  if (
    readout &&
    !trigger &&
    (readout.delivery.invocationId !== job.invocationId ||
      readout.delivery.node !== job.node ||
      readout.delivery.event.revision !== job.revision ||
      canonicalHuddleJson(readout.delivery.inputs) !== canonicalHuddleJson(job.inputs))
  )
    throw new Error('Readout delivery differs from its captured invocation');
  const directory = posix.dirname(manifest);
  const entry = normal(posix.join(directory, component.entry));
  const paths = [
    manifest,
    entry,
    ...component.dependencies.map((path) => normal(posix.join(directory, path))),
  ];
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate captured component file');
  if (
    Object.keys(job.files).length !== paths.length ||
    paths.some((path) => !Object.hasOwn(job.files, path))
  )
    throw new Error('Worker source differs from the declared component closure');
  const declared = huddleComponentSchema.parse(JSON.parse(job.files[manifest]!));
  if (
    canonicalHuddleJson(JSON.parse(JSON.stringify(declared))) !==
    canonicalHuddleJson(JSON.parse(JSON.stringify(component)))
  )
    throw new Error('Captured manifest differs from its component contract');
  return { manifest, entry, directory, paths };
}

/** Trusted code, with deterministic captured imports; this is not an OS sandbox. */
export function installWorkerImports(
  job: HuddleWorkerJob | HuddleTriggerWorkerJob,
  sdkUrl: string,
) {
  const source = checkedWorkerSource(job);
  const urlOf = (path: string) => prefix + path.split('/').map(encodeURIComponent).join('/');
  const modules = new Map(
    source.paths.map((path) => [urlOf(path), { path, text: job.files[path]! }]),
  );
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(prefix) && modules.has(specifier))
        return { url: specifier, shortCircuit: true };
      if (!context.parentURL?.startsWith(prefix)) return nextResolve(specifier, context);
      if (specifier === 'puddlang/huddle' || specifier === 'puddlang' || specifier === 'zod')
        return nextResolve(sdkUrl, context);
      if (specifier.startsWith('node:')) return nextResolve(specifier, context);
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const url = new URL(specifier, context.parentURL).href;
        if (modules.has(url)) return { url, shortCircuit: true };
      }
      throw new Error(`Import is outside the captured component: ${specifier}`);
    },
    load(url, context, nextLoad) {
      const module = modules.get(url);
      if (!module) return nextLoad(url, context);
      if (module.path.endsWith('.json'))
        return { format: 'json', source: module.text, shortCircuit: true };
      if (!/\.(?:m?ts|m?js)$/.test(module.path))
        throw new Error('Unsupported captured module type');
      return {
        format: 'module',
        source: /\.m?ts$/.test(module.path)
          ? stripTypeScriptTypes(module.text, { mode: 'strip', sourceUrl: url })
          : module.text,
        shortCircuit: true,
      };
    },
  });
  return {
    entryUrl: urlOf(source.entry),
    checkContract(contract: string) {
      // Contract paths are relative to the component root, including nested entries.
      if (
        normal(posix.join(source.directory, huddleRelativePathSchema.parse(contract))) !==
        source.manifest
      )
        throw new Error('HuddleNode wrapper names a different contract');
    },
  };
}
