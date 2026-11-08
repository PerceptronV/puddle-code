import type { RuntimeProgrammeTurns } from '../../../runtime/controller/programme-turns.js';
import type { HuddleTurnScope } from '@puddle/shared';
import type { HuddleTurnAuthority } from './authority.js';
import type { HuddleTurnStore } from './store.js';

/** The private owner bridge supplies authority; no browser lease or synthetic programme is used. */
export class HuddleAgentTurns {
  constructor(
    private readonly turns: RuntimeProgrammeTurns,
    private readonly store: HuddleTurnStore,
  ) {}

  ask(
    scope: HuddleTurnScope,
    request: unknown,
    signal: AbortSignal,
    authorised: HuddleTurnAuthority,
    preserveOnAbort?: () => boolean,
    dispatched?: () => void,
  ) {
    const bound = this.store.bind(scope, request, authorised);
    return this.turns.askFor(
      bound.target,
      bound.caller,
      bound.request.prompt,
      signal,
      bound.request.output_schema,
      preserveOnAbort,
      dispatched,
    );
  }

  observe(scope: HuddleTurnScope, request: unknown, authorised: HuddleTurnAuthority) {
    return this.store.bind(scope, request, authorised).observe();
  }

  unused(scope: HuddleTurnScope, request: unknown, authorised: HuddleTurnAuthority) {
    return this.store.bind(scope, request, authorised).unused();
  }

  cancel(scope: HuddleTurnScope, request: unknown, authorised: HuddleTurnAuthority) {
    const bound = this.store.bind(scope, request, authorised);
    const cancellation = bound.cancellation();
    return this.turns.cancelFor(
      bound.target,
      bound.caller,
      cancellation.placement,
      cancellation.turn,
      cancellation.claim,
    );
  }

  acknowledge(
    scope: HuddleTurnScope,
    request: unknown,
    receipt: string,
    authorised: HuddleTurnAuthority,
  ) {
    this.store.bind(scope, request, authorised).acknowledge(receipt);
  }
}
