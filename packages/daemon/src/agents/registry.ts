import { ApiError } from '../http/errors.js';
import type { AgentAdapter } from './adapter.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(adapters: AgentAdapter[]) {
    for (const a of adapters) this.adapters.set(a.id, a);
  }

  get(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw ApiError.badRequest('unknown_agent_type', `no adapter for agent type '${id}'`);
    }
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
