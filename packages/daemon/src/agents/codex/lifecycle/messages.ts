import type { RuntimeBufferBudget } from '../../../runtime/resources/budget.js';
import {
  JSON_VALUE_METADATA_BYTES,
  jsonStructuralValues,
} from '../../../runtime/transport/decoding.js';
import { CODEX_BRIDGE_LIMITS } from './limits.js';
import { parseMessages, type JsonRpcMessage } from './observations.js';

/** Raw receive capacity covers strings/copies; parsed nodes require separate admission. */
export class CodexMessageInspection {
  private readonly bytes: number;
  private messages: JsonRpcMessage[] | null = null;
  private complete: (() => void) | null = null;
  constructor(
    private readonly body: Buffer,
    private readonly budget: RuntimeBufferBudget,
  ) {
    this.bytes =
      JSON_VALUE_METADATA_BYTES *
        jsonStructuralValues(body, { bytes: CODEX_BRIDGE_LIMITS.payloadBytes }) +
      1024;
  }
  read(): JsonRpcMessage[] | null {
    if (this.messages !== null) return this.messages;
    const complete = this.budget.reserve(this.bytes);
    if (!complete) return null;
    this.complete = complete;
    try {
      return (this.messages = parseMessages(this.body));
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close(): void {
    this.messages = null;
    this.complete?.();
    this.complete = null;
  }
}
