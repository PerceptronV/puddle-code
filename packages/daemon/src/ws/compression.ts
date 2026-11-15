import type { PerMessageDeflateOptions } from 'ws';

/** Negotiate on the daemon leg, before an SSH tunnel carries terminal output. */
export const terminalCompression: PerMessageDeflateOptions = {
  // Keep authentication and earlier terminal contents out of later dictionaries.
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  threshold: 1024,
  concurrencyLimit: 4,
  zlibDeflateOptions: { level: 1 },
};
