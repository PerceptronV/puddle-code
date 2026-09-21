import { noise } from '@chainsafe/libp2p-noise';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { privateLogger } from './logger.js';
import { lpStream } from '@libp2p/utils';
import type { MessageStream, Upgrader } from '@libp2p/interface';
import {
  REMOTE_POLICY,
  REMOTE_PROTOCOL_VERSION,
  remoteChunkSchema,
  remoteMessageSchema,
  type RemoteMessage,
} from '@puddle/shared';

export interface ChannelContext {
  service: string;
  host: string;
  hostPeer: string;
  connection: string;
}

/** Fixed encoding, covered by the Noise handshake transcript on both peers. */
export function channelContext(context: ChannelContext): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      'puddle-remote',
      REMOTE_PROTOCOL_VERSION,
      context.service,
      context.host,
      context.hostPeer,
      context.connection,
    ]),
  );
}

export async function secureChannel(
  wire: MessageStream,
  identity: Uint8Array,
  context: ChannelContext,
  direction: 'inbound' | 'outbound',
): Promise<EncryptedChannel> {
  const privateKey = privateKeyFromProtobuf(identity);
  if (privateKey.type !== 'Ed25519') throw new Error('An Ed25519 identity is required');
  // Noise 17's standalone interface only consults getStreamMuxers; negotiation is disabled.
  // No network upgrader, discovery, or multiplexing stack is installed.
  const upgrader = { getStreamMuxers: () => new Map() } as Upgrader;
  const encrypter = noise({ prologueBytes: channelContext(context) })({
    privateKey,
    peerId: peerIdFromPrivateKey(privateKey),
    logger: privateLogger,
    upgrader,
  });
  const options = {
    signal: AbortSignal.timeout(REMOTE_POLICY.handshakeMs),
    skipStreamMuxerNegotiation: true,
  };
  try {
    const secured =
      direction === 'outbound'
        ? await encrypter.secureOutbound(wire, {
            ...options,
            remotePeer: peerIdFromString(context.hostPeer),
          })
        : await encrypter.secureInbound(wire, options);
    // Unknown inbound identities enter pairing-only admission. They get no daemon authority here.
    return new EncryptedChannel(
      secured.connection,
      secured.remotePeer.toString(),
      direction === 'inbound' ? REMOTE_POLICY.requestBytes : REMOTE_POLICY.responseBytes,
    );
  } catch (error) {
    wire.abort(new Error('Encrypted handshake failed'));
    throw error;
  }
}

/** Bounded application chunks within an authenticated Noise stream. No write is replayed. */
export class EncryptedChannel {
  private readonly framed;
  private writing = Promise.resolve();
  private queued = 0;
  private ended = false;
  get closed(): boolean {
    return this.ended || this.stream.status !== 'open';
  }
  constructor(
    private readonly stream: MessageStream,
    readonly peer: string,
    private readonly inboundLimit: number = REMOTE_POLICY.responseBytes,
  ) {
    stream.maxReadBufferLength = REMOTE_POLICY.queueBytes;
    stream.maxWriteBufferLength = REMOTE_POLICY.queueBytes;
    this.framed = lpStream(stream, { maxDataLength: REMOTE_POLICY.frameBytes });
  }
  send(message: RemoteMessage): Promise<void> {
    if (this.ended) return Promise.reject(new Error('Connection is closed'));
    const text = JSON.stringify(message);
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > REMOTE_POLICY.responseBytes || this.queued > REMOTE_POLICY.queueBytes) {
      this.close();
      return Promise.reject(new Error('Remote output exceeded its buffer limit'));
    }
    this.queued += bytes;
    const id = crypto.randomUUID();
    const run = this.writing
      .then(async () => {
        for (let offset = 0, index = 0; offset < text.length; offset += 4096, index++) {
          if (this.ended) throw new Error('Connection is closed');
          const data = JSON.stringify({
            id,
            index,
            end: offset + 4096 >= text.length,
            data: text.slice(offset, offset + 4096),
          });
          await this.framed.write(new TextEncoder().encode(data), {
            signal: AbortSignal.timeout(10_000),
          });
        }
      })
      .finally(() => {
        this.queued -= bytes;
      });
    this.writing = run.catch(() => this.close());
    return run;
  }
  async *messages(): AsyncGenerator<RemoteMessage> {
    let partial = '';
    let id: string | null = null;
    let index = 0;
    let bytes = 0;
    try {
      while (!this.ended) {
        const raw = await this.framed.read();
        const chunk = remoteChunkSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray())),
        );
        if (chunk.index !== index || (id !== null && id !== chunk.id))
          throw new Error('Out-of-order remote message');
        id = chunk.id;
        bytes += new TextEncoder().encode(chunk.data).byteLength;
        if (bytes > this.inboundLimit) throw new Error('Remote message is too large');
        partial += chunk.data;
        index++;
        if (chunk.end) {
          const message = remoteMessageSchema.parse(JSON.parse(partial));
          partial = '';
          id = null;
          index = 0;
          bytes = 0;
          yield message;
        }
      }
    } finally {
      this.close();
    }
  }
  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.stream.abort(new Error('Remote connection closed'));
  }
}
