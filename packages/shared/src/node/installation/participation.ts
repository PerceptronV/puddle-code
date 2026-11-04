import type { Readable } from 'node:stream';

/** Trusted helper/dispatcher lifetime. Revocation never kills an accepted independent job. */
export function watchUpdateParticipation(input: Readable) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const event of ['end', 'close', 'error']) input.on(event, abort);
  for (const signal of signals) process.on(signal, abort);
  if (input.destroyed || input.readableEnded) abort();
  return {
    signal: controller.signal,
    abort,
    dispose() {
      for (const event of ['end', 'close', 'error']) input.off(event, abort);
      for (const signal of signals) process.off(signal, abort);
    },
  };
}
