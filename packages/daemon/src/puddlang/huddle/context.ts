import type {
  HuddleJson,
  HuddleTriggerEmission,
  HuddleTriggerHealth,
  HuddleDelivery,
  HuddleDeliveryResult,
} from '@puddle/shared';

export type HuddleValues = Readonly<Record<string, HuddleJson>>;
export interface HuddleNodeContext {
  inputs: HuddleValues;
  parameters: HuddleValues;
  /** Resolved host references are still rechecked at operation dispatch. */
  bindings: Readonly<Record<string, string>>;
  puddlang: Pick<typeof import('../runtime-api.js'), 'spawn' | 'attach'>;
  signal: AbortSignal;
  /** Resolves only after the owner durably records this exact event-port emission. */
  emit(port: string, value: HuddleJson): Promise<void>;
}

export interface HuddleExtensionContext {
  parameters: HuddleValues;
  bindings: Readonly<Record<string, string>>;
  signal: AbortSignal;
  log(message: string): void;
}

export interface HuddleTriggerContext extends HuddleExtensionContext {
  health(value: HuddleTriggerHealth): void;
  /** Cursor advancement is atomic with inbox admission; this is not a viewer acknowledgement. */
  emit(value: HuddleTriggerEmission): Promise<{ sequence: number; duplicate: boolean }>;
}

export interface HuddleTriggerAdapter {
  contract: string;
  /** Resolution establishes a subscription, not proof that every missed event was recovered. */
  open(context: HuddleTriggerContext, cursor: HuddleJson): Promise<{ close(): Promise<void> }>;
}

export interface HuddleReadoutAdapter {
  contract: string;
  /** Retry admission also requires the owner's exact delivery ledger. */
  idempotent: boolean;
  deliver(context: HuddleExtensionContext, delivery: HuddleDelivery): Promise<HuddleDeliveryResult>;
  observe?(
    context: HuddleExtensionContext,
    delivery: HuddleDelivery,
  ): Promise<HuddleDeliveryResult>;
}
