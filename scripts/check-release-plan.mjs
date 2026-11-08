#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readReleasePlan, validateReleasePlan, legacyReleasePlan } from './lib/releases/plan.mjs';
const version = process.argv[2]?.replace(/^v/, '');
const plan = readReleasePlan(process.cwd(), version, true);
if (process.argv.includes('--verify-history')) {
  const source = (target, file) =>
    target === version
      ? readFileSync(file, 'utf8')
      : execFileSync('git', ['show', `v${target}:${file}`], {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        });
  const major = (target, file, name) => {
    const match = new RegExp(`${name}\\s*=\\s*\\{\\s*major:\\s*(\\d+)`).exec(source(target, file));
    if (!match) throw new Error(`Cannot read ${name} for ${target}`);
    return Number(match[1]);
  };
  for (const component of ['daemon', 'runtime']) {
    const target = plan.components[component];
    if (target === version) continue;
    let archived;
    try {
      archived = source(target, 'release-manifest.json');
    } catch {
      continue;
    } // Legacy all-component tags have no manifest.
    const prior = validateReleasePlan(JSON.parse(archived), target);
    if (prior.components?.[component] !== target)
      throw new Error(`No ${component} was published at ${target}`);
  }
  const application = 'packages/shared/src/protocol.ts';
  const runtime = 'packages/shared/src/runtime/protocol.ts';
  if (
    major(version, application, 'PROTOCOL_VERSION') !==
    major(plan.components.daemon, application, 'PROTOCOL_VERSION')
  )
    throw new Error('The retained daemon is incompatible with this frontend; publish a daemon');
  if (
    major(plan.components.daemon, runtime, 'RUNTIME_PROTOCOL_VERSION') !==
    major(plan.components.runtime, runtime, 'RUNTIME_PROTOCOL_VERSION')
  )
    throw new Error('The daemon and runtime protocol majors differ; publish compatible components');
}
const host = plan.components.daemon === version || plan.components.runtime === version;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `host=${host}\n`);
if (process.argv.includes('--stage')) {
  mkdirSync('dist-release', { recursive: true });
  writeFileSync('dist-release/release-manifest-v2.json', JSON.stringify(plan, null, 2) + '\n');
  writeFileSync(
    'dist-release/release-manifest.json',
    JSON.stringify(legacyReleasePlan(plan), null, 2) + '\n',
  );
  for (const component of ['daemon', 'runtime'])
    writeFileSync(`dist-release/${component}-version`, plan.components[component] + '\n');
}
console.log(`Release ${version}: ${JSON.stringify(plan.components)}`);
