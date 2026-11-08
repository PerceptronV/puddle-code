import type {
  HuddleAgentOperation,
  HuddleSpawnOperation,
  HuddleLifecycleOperation,
} from '@puddle/shared';
import type { HuddleOwnerClient } from '../../../runtime/huddle/transport/client.js';

export interface HuddleDispatchTask<
  T extends HuddleAgentOperation | HuddleSpawnOperation | HuddleLifecycleOperation,
> {
  operation: T;
  abort: AbortController;
}

export interface HuddleDispatchContext<
  T extends HuddleAgentOperation | HuddleSpawnOperation | HuddleLifecycleOperation,
> {
  task: HuddleDispatchTask<T>;
  client: HuddleOwnerClient;
  current(): boolean;
  authority(mode: 'dispatch' | 'observe'): boolean;
  canCancel(): boolean;
  changed(): void;
}
