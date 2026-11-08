/** Identity tombstones are retained until operation-aware collection exists; pressure refuses new asks. */
export const HUDDLE_TURN_BINDING_LIMITS = { execution: 1000, owner: 16_384, host: 65_536 } as const;
export type HuddleTurnBindingLimits = { [K in keyof typeof HUDDLE_TURN_BINDING_LIMITS]: number };
