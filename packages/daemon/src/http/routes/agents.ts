import { Hono } from 'hono';
import type { AgentType } from '@puddle/shared';
import type { AdapterRegistry } from '../../agents/registry.js';

/** Registered agent adapters — the UI's add-account choices (SPEC §11). */
export function agentRoutes(deps: { adapters: AdapterRegistry }): Hono {
  return new Hono().get('/', (c) =>
    c.json<AgentType[]>(
      deps.adapters.list().map((adapter) => ({
        id: adapter.id,
        display_name: adapter.displayName,
        capabilities: {
          resume: adapter.capabilities.resume,
          skip_permissions: adapter.capabilities.skipPermissions,
        },
      })),
    ),
  );
}
