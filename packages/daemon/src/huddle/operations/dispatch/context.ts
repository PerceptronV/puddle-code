import type { HuddleAgentOperation, HuddleSpawnOperation } from '@puddle/shared';
import type { HuddleOwnerClient } from '../../../runtime/huddle/transport/client.js';

export interface HuddleDispatchTask<T extends HuddleAgentOperation | HuddleSpawnOperation> {
  operation: T;
  abort: AbortController;
}

export interface HuddleDispatchContext<T extends HuddleAgentOperation | HuddleSpawnOperation> {
  task: HuddleDispatchTask<T>;
  client: HuddleOwnerClient;
  current(): boolean;
  authority(mode: 'dispatch' | 'observe'): boolean;
  canCancel(): boolean;
  changed(): void;
}
