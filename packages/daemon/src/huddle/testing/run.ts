import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  coreHuddleComponents,
  huddleIdSchema,
  huddleRelativePathSchema,
  huddleWorkerJobSchema,
  huddleTriggerWorkerJobSchema,
} from '@puddle/shared';
import { captureHuddleDefinition } from '../definitions/capture.js';
import { checkedHuddlePath, readHuddleFile } from '../definitions/files.js';
import { huddleExecutableFixtureSchema, type HuddleExecutableCase } from './fixture.js';
import type { HuddleDefinitionSnapshot } from '../definitions/capture.js';

/** Standalone trusted-code test command. It has no Puddle connection or execution authority. */
async function main() {
  const { values } = parseArgs({
    options: {
      worktree: { type: 'string' },
      huddle: { type: 'string' },
      fixture: { type: 'string' },
      timeout: { type: 'string', default: '10000' },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values.worktree || !isAbsolute(values.worktree) || !values.huddle || !values.fixture)
    throw new Error(
      'Usage: node testing/run.mjs --worktree /absolute/root --huddle ID --fixture fixtures/executable.json [--timeout 10000]',
    );
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000)
    throw new Error('Timeout must be 100–30000 milliseconds per case');
  const worktree = await realpath(values.worktree);
  const id = huddleIdSchema.parse(values.huddle);
  const path = huddleRelativePathSchema.parse(values.fixture);
  const root = await checkedHuddlePath(worktree, `.puddle/huddle/${id}`);
  const fixture = huddleExecutableFixtureSchema.parse(JSON.parse(await readHuddleFile(root, path)));
  const snapshot = await captureHuddleDefinition(worktree, id, coreHuddleComponents);
  const environment = Object.fromEntries(
    ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  );
  const results = [];
  for (const sample of fixture.cases) {
    try {
      const job = prepareCase(snapshot, sample);
      const child = spawnSync(
        process.execPath,
        ['--max-old-space-size=128', fileURLToPath(new URL('./worker.mjs', import.meta.url))],
        {
          cwd: worktree,
          env: environment,
          input: JSON.stringify({ job, fixture: sample }),
          encoding: 'utf8',
          timeout,
          maxBuffer: 1024 * 1024,
          killSignal: 'SIGKILL',
        },
      );
      if (child.error) throw child.error;
      if (child.signal) throw new Error(`Fixture process ended with ${child.signal}`);
      const result: unknown = JSON.parse(child.stdout);
      if (
        !result ||
        typeof result !== 'object' ||
        !('passed' in result) ||
        typeof result.passed !== 'boolean'
      )
        throw new Error('Fixture process returned an invalid result');
      results.push({
        name: sample.name,
        node: sample.node,
        passed: child.status === 0 && result.passed,
        ...('error' in result ? { error: String(result.error).slice(0, 8192) } : {}),
        ...(child.stderr ? { log: child.stderr.slice(0, 16384) } : {}),
      });
    } catch (error) {
      results.push({
        name: sample.name,
        node: sample.node,
        passed: false,
        error: String(error).slice(0, 8192),
      });
    }
  }
  const passed = results.every((result) => result.passed);
  process.stdout.write(
    JSON.stringify({ format: 1, revision: snapshot.digest, passed, cases: results }, null, 2) +
      '\n',
  );
  process.exitCode = passed ? 0 : 1;
}

function prepareCase(snapshot: HuddleDefinitionSnapshot, sample: HuddleExecutableCase) {
  const node = snapshot.definition.nodes.find((node) => node.id === sample.node);
  const component = snapshot.components[sample.node];
  if (node?.source.kind !== 'local' || !component?.entry)
    throw new Error('Fixture requires a resolved local component node');
  const parameters = {
    ...Object.fromEntries(
      Object.entries(component.parameters).flatMap(([name, value]) =>
        value.default === undefined ? [] : [[name, value.default]],
      ),
    ),
    ...sample.parameters,
  };
  if (
    component.capabilities.some((value) => ['files', 'git', 'sessions'].includes(value)) &&
    (typeof parameters.worktree !== 'string' || !isAbsolute(parameters.worktree))
  )
    throw new Error(
      'File, Git and session fixtures require an explicit absolute worktree parameter',
    );
  const manifest = posix.normalize(node.source.manifest);
  const directory = posix.dirname(manifest);
  const paths = [
    manifest,
    ...[component.entry, ...component.dependencies].map((path) => posix.join(directory, path)),
  ];
  const source = {
    revision: snapshot.digest,
    node: node.id,
    manifest,
    component,
    parameters,
    bindings: sample.bindings,
    files: Object.fromEntries(paths.map((path) => [path, snapshot.files[path]])),
  };
  if (component.category === 'trigger' && !component.hostTrigger)
    return huddleTriggerWorkerJobSchema.parse({
      ...source,
      subscriptionId: randomUUID(),
      cursor: sample.cursor,
    });
  const invocationId = randomUUID();
  return huddleWorkerJobSchema.parse({
    ...source,
    invocationId,
    inputs: sample.inputs,
    ...(component.category === 'readout'
      ? {
          readout: {
            mode: sample.mode,
            delivery: {
              format: 1,
              id: randomUUID(),
              idempotencyKey: 'f'.repeat(64),
              invocationId,
              node: node.id,
              inputs: sample.inputs,
              event: {
                format: 1,
                id: randomUUID(),
                source: { node: 'fixture', component: 'fixture.trigger', version: 1 },
                port: 'event',
                observedAt: new Date().toISOString(),
                revision: snapshot.digest,
                executionId: randomUUID(),
                data: sample.inputs,
                scope: {
                  hostId: 'fixture',
                  profileId: '0'.repeat(10),
                  projectId: '1'.repeat(10),
                  huddleId: snapshot.definition.id,
                  sessionId: randomUUID(),
                  runtimeId: randomUUID(),
                },
              },
            },
          },
        }
      : {}),
  });
}

void main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
