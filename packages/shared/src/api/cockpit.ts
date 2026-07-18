import { z } from 'zod';

/**
 * The cockpit-local control surface (SPEC §10): endpoints served by the CLI's
 * UI server itself, never by puddled — like the `X-Puddle-Cockpit` nonce
 * header and the `?host=`/`#token=` boot params, they sit OUTSIDE
 * `PROTOCOL_VERSION` (the UI and the cockpit that serves it ship in one npm
 * package, so the two ends cannot skew beyond a page reload). Shapes still
 * live here so no side of the repo defines them locally.
 */

/** `POST /cockpit/refresh` 202 body — the cockpit is replacing itself. */
export const cockpitRefreshResponseSchema = z.object({
  status: z.literal('refreshing'),
});
export type CockpitRefreshResponse = z.infer<typeof cockpitRefreshResponseSchema>;
