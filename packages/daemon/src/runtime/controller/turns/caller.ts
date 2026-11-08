import type { RuntimePlacement, RuntimeTurnResult, RuntimeTurnOrigin } from '@puddle/shared';

/** Host-owned admission adapter. This is not a serialisable credential or a public API. */
export interface RuntimeTurnCaller {
  origin?(): RuntimeTurnOrigin;
  check(runtimeId: string): void;
  reserve(
    runtimeId: string,
    placement: RuntimePlacement,
    expectedRef: string | null,
    observedTurn: number,
  ): number;
  read(runtimeId: string, turn: number): RuntimeTurnResult | null;
  checkCancellation(runtimeId: string, turn: number): void;
  releaseUnused(
    runtimeId: string,
    placement: RuntimePlacement,
    expectedRef: string | null,
    turn: number,
  ): void;
}
