import {
  canonicalHuddleJson,
  huddleExecutionInputSchema,
  type HuddleExecutionInput,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { HuddleStateDatabase } from './database.js';

type Address = Pick<HuddleExecutionInput, 'executionId' | 'revision' | 'node' | 'port'>;

export class HuddleExecutionInputs {
  constructor(private readonly db: HuddleStateDatabase) {}

  get(address: Address) {
    const row = this.db.get('execution-inputs', this.key(address));
    if (!row) return undefined;
    const input = huddleExecutionInputSchema.parse(JSON.parse(row.body));
    if (
      input.revision !== address.revision ||
      input.executionId !== address.executionId ||
      input.node !== address.node ||
      input.port !== address.port
    )
      throw new Error('Execution input identity changed');
    return input;
  }

  /** The caller commits this and all newly ready joins with the originating emission. */
  set(raw: HuddleExecutionInput) {
    const input = huddleExecutionInputSchema.parse(raw);
    const before = this.get(input);
    if (before) {
      if (canonicalHuddleJson(before) !== canonicalHuddleJson(input))
        throw new Error('Two deliveries compete for the same execution input');
      return false;
    }
    this.db.put('execution-inputs', this.key(input), input.executionId, 'bound', input);
    return true;
  }

  private key({ executionId, node, port }: Address) {
    return digest(canonicalHuddleJson({ executionId, node, port }));
  }
}
