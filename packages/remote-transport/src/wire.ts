import { AbstractMessageStream, type SendResult } from '@libp2p/utils';
import { privateLogger } from './logger.js';
import { REMOTE_POLICY } from '@puddle/shared';

export interface WireSocket {
  send(data: Uint8Array): void;
  close(): void;
  readonly bufferedAmount: number;
}

/** WebSocket byte adapter. Encryption belongs entirely to the Noise library. */
export class SocketWire extends AbstractMessageStream {
  private readonly drainTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly socket: WireSocket,
    direction: 'inbound' | 'outbound',
  ) {
    super({
      direction,
      log: privateLogger.forComponent('puddle:wire'),
      maxReadBufferLength: REMOTE_POLICY.queueBytes,
      maxWriteBufferLength: REMOTE_POLICY.queueBytes,
      maxMessageSize: REMOTE_POLICY.frameBytes,
    });
    this.drainTimer = setInterval(() => {
      if (socket.bufferedAmount < REMOTE_POLICY.queueBytes / 2) this.safeDispatchEvent('drain');
    }, 20);
    this.addEventListener('close', () => clearInterval(this.drainTimer), { once: true });
  }
  sendData(data: Parameters<AbstractMessageStream['sendData']>[0]): SendResult {
    if (this.socket.bufferedAmount + data.byteLength > REMOTE_POLICY.queueBytes)
      return { sentBytes: 0, canSendMore: false };
    this.socket.send(data.subarray());
    return {
      sentBytes: data.byteLength,
      canSendMore: this.socket.bufferedAmount < REMOTE_POLICY.queueBytes / 2,
    };
  }
  receive(data: Uint8Array): void {
    if (data.byteLength > REMOTE_POLICY.frameBytes)
      return this.abort(new Error('Remote frame is too large'));
    this.onData(data);
  }
  sendReset(): void {
    clearInterval(this.drainTimer);
    this.socket.close();
  }
  // WebSocket has no peer-pause primitive. Both the read buffer and relay queue are bounded.
  sendPause(): void {}
  sendResume(): void {}
  async close(): Promise<void> {
    clearInterval(this.drainTimer);
    this.socket.close();
    this.onTransportClosed();
  }
}
