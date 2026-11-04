import type { Duplex, Readable, Writable } from 'node:stream';
import {
  hostUpdateControlRequestSchema,
  hostUpdateControlResponseSchema,
  type HostUpdateCommand,
} from '@puddle/shared';
import { jsonLines } from '@puddle/shared/node';
import { HostUpdateRequests, watchUpdateParticipation } from '@puddle/shared/node/host-control';
import { continueStoredHostUpdate } from './continuation.js';

/** One existing private request envelope; no lease is issued and nothing is retried. */
export async function requestParticipatingUpdate(
  channel: Duplex,
  command: HostUpdateCommand,
  signal: AbortSignal,
  authorised: () => boolean,
) {
  const requests = new HostUpdateRequests(channel);
  const close = () => {
    requests.close();
    channel.destroy();
  };
  const stop = jsonLines(
    channel,
    (value) => {
      if (!requests.receive(hostUpdateControlResponseSchema.parse(value))) close();
    },
    close,
  );
  channel.on('end', close);
  channel.on('close', close);
  channel.on('error', close);
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted || !authorised()) throw new Error('Host recovery authority expired');
    return await requests.request(command);
  } finally {
    signal.removeEventListener('abort', close);
    stop();
    close();
  }
}

/** Keep the SSH helper's input open through asynchronous validation and durable dispatch. */
export async function serveParticipatingUpdate(home: string, input: Readable, output: Writable) {
  const participation = watchUpdateParticipation(input);
  let stop = () => {};
  let received = false;
  let ended = () => {};
  const timer = setTimeout(participation.abort, 135_000);
  timer.unref();
  output.on('error', participation.abort);
  try {
    await new Promise<void>((resolve) => {
      ended = () => {
        if (!received) resolve();
      };
      participation.signal.addEventListener('abort', ended, { once: true });
      stop = jsonLines(
        input,
        (value) => {
          if (received) {
            participation.abort();
            return;
          }
          const request = hostUpdateControlRequestSchema.parse(value);
          received = true;
          void continueStoredHostUpdate(home, request.command, {
            signal: participation.signal,
            authorised: () => !participation.signal.aborted,
          })
            .then((result) => {
              if (!participation.signal.aborted)
                output.write(
                  JSON.stringify({
                    t: 'host-update-result',
                    request_id: request.request_id,
                    result,
                  }) + '\n',
                );
            })
            .catch(participation.abort)
            .finally(resolve);
        },
        participation.abort,
        16 * 1024,
      );
      if (participation.signal.aborted) ended();
    });
  } finally {
    clearTimeout(timer);
    stop();
    participation.signal.removeEventListener('abort', ended);
    participation.dispose();
    input.destroy();
  }
}
