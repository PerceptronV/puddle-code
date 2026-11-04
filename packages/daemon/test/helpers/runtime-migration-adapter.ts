import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicPrivateJson, privateDirectory } from '@puddle/shared/node';
import type { AgentAdapter, LifecycleLaunchContext } from '../../src/agents/adapter.js';
import { runtimeTestAdapter } from './runtime-test-adapter.js';

const conversation = (directory: string, ref: string) =>
  join(directory, `${ref}.conversation.json`);
async function prepare(context: LifecycleLaunchContext) {
  privateDirectory(context.account.config_dir);
  const ref = context.resumeRef ?? context.opts.sessionId;
  if (context.resumeRef && !existsSync(conversation(context.account.config_dir, ref)))
    throw new Error('Exact fixture conversation is absent from the target account');
  if (!context.resumeRef)
    atomicPrivateJson(conversation(context.account.config_dir, ref), {
      ref,
      transcript: 'preserved',
    });
  atomicPrivateJson(join(context.account.config_dir, `${context.opts.sessionId}.migration.json`), {
    ref,
    resumed: !!context.resumeRef,
  });
  return runtimeTestAdapter.prepareLifecycleLaunch!(context);
}

/** Isolated copy-capable provider: real owner, shell, sidecar and exact transcript file. */
export const runtimeMigrationTestAdapter: AgentAdapter = {
  ...runtimeTestAdapter,
  id: 'runtime-migration-test',
  capabilities: {
    ...runtimeTestAdapter.capabilities,
    presetSessionId: true,
    migratableSessions: true,
  },
  env: (account) => ({ MIGRATION_ACCOUNT: account.config_dir }),
  resolveSessionRef: async (opts) => opts.sessionId,
  hasConversation: (ref, account) => existsSync(conversation(account.config_dir, ref)),
  migrateSession: async (ref, from, to) => {
    privateDirectory(to.config_dir);
    copyFileSync(conversation(from.config_dir, ref), conversation(to.config_dir, ref));
  },
  prepareLifecycleLaunch: prepare,
  prepareHeadlessLaunch: prepare,
};
