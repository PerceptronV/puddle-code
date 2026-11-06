import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicPrivateJson } from '@puddle/shared/node';
import type { LifecycleLaunchContext } from '../../adapter.js';
import { installHookDispatcher, writeManagedHelper } from '../../managed-helpers.js';

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const DISPATCHER = 'puddle-claude-hooks-v2.sh';
const ROUTE = '.puddle-runtime-route.json';

// Background jobs inherit the source's environment. Only an explicitly attached
// owner supplies their replacement route; absent routes remain inert.
export const CLAUDE_JOB_ROUTER_SOURCE = String.raw`
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const privateFile = (file, directory = false) => {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o077) || (!directory && stat.size > 16384))
    throw new Error('Unavailable route');
};
try {
  const config = resolve(process.argv[2]);
  const job = resolve(process.env.CLAUDE_JOB_DIR || '');
  if (dirname(job) !== join(config, 'jobs') || !/^[a-f0-9]{8}$/.test(job.slice(job.lastIndexOf('/') + 1))) process.exit(0);
  const helper = process.argv[3];
  if (!['puddle-signal.mjs', 'puddle-turn.mjs', 'puddle-statusline.mjs'].includes(helper)) process.exit(0);
  const file = join(job, '${ROUTE}');
  privateFile(file);
  const route = JSON.parse(readFileSync(file, 'utf8'));
  if (route.version !== 1 || typeof route.nonce !== 'string' || typeof route.url !== 'string' ||
      typeof route.node !== 'string' || typeof route.helpers !== 'string' || typeof route.turns !== 'string') process.exit(0);
  privateFile(route.helpers, true);
  const env = { ...process.env, PUDDLE_AGENT_SIGNAL_URL: route.url, PUDDLE_AGENT_SIGNAL_NONCE: route.nonce,
    PUDDLE_AGENT_HELPER_DIR: route.helpers, PUDDLE_AGENT_HELPER_NODE: route.node, PUDDLE_AGENT_TURN_STATE_DIR: route.turns };
  delete env.CLAUDE_JOB_DIR;
  const child = spawn(route.node, [join(route.helpers, helper), ...process.argv.slice(4)], { env, stdio: 'inherit' });
  child.on('error', () => process.exit(0));
  child.on('exit', () => process.exit(0));
} catch { process.exit(0); }
`;

export function installClaudeHookDispatcher(directory: string): void {
  mkdirSync(join(directory, 'jobs'), { recursive: true, mode: 0o700 });
  installHookDispatcher(directory);
  writeManagedHelper(join(directory, 'puddle-claude-job-router.mjs'), CLAUDE_JOB_ROUTER_SOURCE);
  writeManagedHelper(
    join(directory, DISPATCHER),
    `#!/bin/sh
if [ -n "\${CLAUDE_JOB_DIR-}" ]; then
  exec ${quote(process.execPath)} ${quote(join(directory, 'puddle-claude-job-router.mjs'))} ${quote(directory)} "$@"
fi
exec /bin/sh ${quote(join(directory, 'puddle-hooks-v1.sh'))} "$@"
`,
  );
}
export function claudeHookCommand(directory: string, file: string, ...args: string[]): string {
  return ['/bin/sh', join(directory, DISPATCHER), file, ...args].map(quote).join(' ');
}

export function routeClaudeJob(context: LifecycleLaunchContext, id: string): () => void {
  const file = join(context.account.config_dir, 'jobs', id, ROUTE);
  const helpers = context.env?.['PUDDLE_AGENT_HELPER_DIR'];
  const node = context.env?.['PUDDLE_AGENT_HELPER_NODE'];
  const turns = context.env?.['PUDDLE_AGENT_TURN_STATE_DIR'];
  if (!helpers || !node || !turns) throw new Error('Claude job attachment requires pinned helpers');
  atomicPrivateJson(file, {
    version: 1,
    nonce: context.signalNonce,
    url: context.signalUrl,
    helpers,
    node,
    turns,
  });
  return () => {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).nonce === context.signalNonce) rmSync(file);
    } catch {
      /* A replacement owner retains its route. */
    }
  };
}
