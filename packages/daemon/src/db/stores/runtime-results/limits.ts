import { RUNTIME_LIMITS } from '@puddle/shared';

/** Charged result JSON/reservations, not SQLite pages, journals or user storage. */
export const RUNTIME_RESULT_LIMITS = { turns: 128, bytes: 16 * 1024 * 1024 } as const;
export const HOST_RESULT_LIMITS = { turns: 8192, bytes: 256 * 1024 * 1024 } as const;
export const RESULT_RESERVATION_BYTES = 6 * RUNTIME_LIMITS.turnReplyBytes + 32 * 1024;

export interface ResultCapacityLimits {
  runtime: { turns: number; bytes: number };
  host: { turns: number; bytes: number };
}
export const RESULT_CAPACITY_LIMITS: ResultCapacityLimits = {
  runtime: RUNTIME_RESULT_LIMITS,
  host: HOST_RESULT_LIMITS,
};
