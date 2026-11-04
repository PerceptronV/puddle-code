import {
  RuntimeBufferBudget,
  type RuntimeByteAllowance,
} from '../../../runtime/resources/budget.js';

/** Preserve ws's existing 100 MiB native message ceiling; idle bridges reserve no body bytes. */
export const CODEX_BRIDGE_LIMITS = Object.freeze({
  payloadBytes: 100 * 1024 * 1024,
  receiveBytes: 896 * 1024 * 1024,
  receiveChunks: 16_384,
  sendBytes: 256 * 1024 * 1024,
  sendMessages: 1024,
  pendingBytes: 1024 * 1024,
  pendingRequests: 256,
  signalsBytes: 1024 * 1024,
  signals: 256,
});

export class CodexBridgeBudgets {
  readonly receive: RuntimeBufferBudget;
  readonly send: RuntimeBufferBudget;
  readonly metadata: RuntimeBufferBudget;
  readonly pending: RuntimeBufferBudget;
  readonly signals: RuntimeBufferBudget;
  constructor(allowance?: RuntimeByteAllowance) {
    this.receive = new RuntimeBufferBudget(
      { bytes: CODEX_BRIDGE_LIMITS.receiveBytes, count: CODEX_BRIDGE_LIMITS.receiveChunks },
      allowance,
    );
    // No IPC traversal/depth restriction is imposed on native messages. The
    // enclosing owner still admits structural metadata before native parsing.
    this.metadata = new RuntimeBufferBudget(
      { bytes: 256 * (CODEX_BRIDGE_LIMITS.payloadBytes + 1) + 1024, count: 1024 },
      allowance,
    );
    this.send = new RuntimeBufferBudget(
      { bytes: CODEX_BRIDGE_LIMITS.sendBytes, count: CODEX_BRIDGE_LIMITS.sendMessages },
      allowance,
    );
    this.pending = new RuntimeBufferBudget(
      { bytes: CODEX_BRIDGE_LIMITS.pendingBytes, count: CODEX_BRIDGE_LIMITS.pendingRequests },
      allowance,
    );
    this.signals = new RuntimeBufferBudget(
      { bytes: CODEX_BRIDGE_LIMITS.signalsBytes, count: CODEX_BRIDGE_LIMITS.signals },
      allowance,
    );
  }
}
