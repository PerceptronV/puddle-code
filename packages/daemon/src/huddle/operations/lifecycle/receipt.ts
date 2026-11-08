import {
  canonicalHuddleJson,
  type HuddleAgentTarget,
  type HuddleLifecycleRequest,
  type HuddleSpawnScope,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';

export function huddleLifecycleReceipt(
  scope: HuddleSpawnScope,
  request: HuddleLifecycleRequest,
  agent: HuddleAgentTarget,
) {
  return digest(canonicalHuddleJson({ scope, request, agent }));
}
