import { connect } from 'node:net';
import {
  controlRequestSchema,
  controlResponseSchema,
  hostUpdateControlRequestSchema,
} from '@puddle/shared';
import { ipcPath, jsonLines, privatePath } from '@puddle/shared/node';
import { clientHome } from './lib/paths.js';
import { inspectHostLocally } from './lib/auth/host-inspection.js';
import { inspectStoredHostUpdate } from './lib/host/updates/inspection.js';
import { continueStoredHostUpdate } from './lib/host/updates/continuation.js';

// stdout is exclusively the bounded control protocol; diagnostics never contain credentials.
if (process.argv.length === 3 && ['--updates', '--continue-update'].includes(process.argv[2]!)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (Buffer.byteLength(input) > 16 * 1024)
        throw new Error('Inspection input exceeds its limit');
    }
    const request = hostUpdateControlRequestSchema.parse(JSON.parse(input));
    const result =
      process.argv[2] === '--continue-update'
        ? await continueStoredHostUpdate(clientHome(), request.command)
        : inspectStoredHostUpdate(clientHome(), request.command);
    process.stdout.write(
      JSON.stringify({ t: 'host-update-result', request_id: request.request_id, result }) + '\n',
    );
  } catch {
    process.stdout.write(JSON.stringify({ t: 'error', code: 'rejected' }) + '\n');
  }
} else if (process.argv.includes('--inspect')) {
  const inspection = await inspectHostLocally(clientHome()).catch(() => ({
    t: 'error',
    code: 'rejected',
  }));
  process.stdout.write(JSON.stringify(inspection ?? { t: 'error', code: 'unavailable' }) + '\n');
} else {
  const path = ipcPath(clientHome(), 'host');
  privatePath(path);
  const socket = connect(path);
  const stop = () => {
    socket.destroy();
    process.stdin.destroy();
  };
  jsonLines(
    process.stdin,
    (value) => {
      const message = controlRequestSchema.parse(value);
      if (!socket.write(JSON.stringify(message) + '\n')) process.stdin.pause();
    },
    stop,
  );
  jsonLines(
    socket,
    (value) => {
      const message = controlResponseSchema.parse(value);
      if (!process.stdout.write(JSON.stringify(message) + '\n')) socket.pause();
    },
    stop,
  );
  socket.on('drain', () => process.stdin.resume());
  process.stdout.on('drain', () => socket.resume());
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdout.on('error', stop);
  socket.on('error', stop);
  socket.on('close', stop);
}
