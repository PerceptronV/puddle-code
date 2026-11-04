import { randomUUID } from 'node:crypto';
import type { RuntimeAttention } from '@puddle/shared';

/** Bounded replaceable state survives controller outages, without an alert backlog. */
export class RuntimeAttentionState {
  private current: RuntimeAttention | null = null;
  constructor(private readonly changed: (attention: RuntimeAttention | null) => void) {}

  get(): RuntimeAttention | null {
    return this.current ? { ...this.current } : null;
  }

  waiting(segment: string): void {
    if (this.current?.reason === 'waiting_input' && this.current.segment_id === segment) return;
    this.set(segment, 'waiting_input');
  }

  exited(segment: string): void {
    this.set(segment, 'exited');
  }

  clear(): void {
    if (!this.current) return;
    this.current = null;
    this.changed(null);
  }

  private set(segment: string, reason: RuntimeAttention['reason']): void {
    this.current = {
      id: randomUUID(),
      segment_id: segment,
      reason,
      created_at: new Date().toISOString(),
    };
    this.changed(this.get());
  }
}
