import { z } from 'zod';

/**
 * GET /api/agents: the daemon's registered agent adapters, with the
 * capabilities the UI needs for gating (e.g. hiding skip toggles for
 * adapters that cannot skip permission prompts).
 */
export const agentTypeSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  capabilities: z.object({
    resume: z.boolean(),
    skip_permissions: z.boolean(),
  }),
});
export type AgentType = z.infer<typeof agentTypeSchema>;
