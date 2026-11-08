import {
  canonicalHuddleJson,
  type HuddleAgentTarget,
  type HuddleSpawnRequest,
  type HuddleSpawnScope,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';

/** Shared by host persistence and owner settlement; not a substitute for private IPC authority. */
export function huddleSpawnReceipt(
  scope: HuddleSpawnScope,
  request: HuddleSpawnRequest,
  agent: HuddleAgentTarget,
) {
  const intent = canonicalHuddleJson({ scope, request });
  return digest(canonicalHuddleJson({ intent, agent }));
}
