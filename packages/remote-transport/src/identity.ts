import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

export async function createIdentity(): Promise<Uint8Array> {
  return privateKeyToProtobuf(await generateKeyPair('Ed25519'));
}
export function identityPeer(bytes: Uint8Array): string {
  const key = privateKeyFromProtobuf(bytes);
  if (key.type !== 'Ed25519') throw new Error('An Ed25519 identity is required');
  return peerIdFromPrivateKey(key).toString();
}
