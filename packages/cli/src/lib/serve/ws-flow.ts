import WebSocket from 'ws';

const HIGH_WATER_BYTES = 256 * 1024;
const LOW_WATER_BYTES = 64 * 1024;

/** Backpressure each bridge direction independently; never queue or replay input ourselves. */
export function forwardWsMessage(
  source: WebSocket,
  destination: WebSocket,
  data: string | Buffer | ArrayBuffer | Buffer[],
  valid: () => boolean,
  close: () => void,
): void {
  if (!valid() || destination.readyState !== WebSocket.OPEN) return close();
  destination.send(data, { binary: false }, (error) => {
    if (error || !valid()) return close();
    if (source.readyState === WebSocket.OPEN && destination.bufferedAmount <= LOW_WATER_BYTES)
      source.resume();
  });
  if (destination.bufferedAmount >= HIGH_WATER_BYTES) source.pause();
}
