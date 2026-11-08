import {
  onlineHostUpdateRequestSchema,
  versionResponseSchema,
  supportsApplicationFeature,
  type FrontendHostUpdateRequest,
} from '@puddle/shared';
import { api, ApiError } from '../../lib/transport/api';
import { browserTransport } from '../../lib/transport/browser-transport';

export function hostUpdateScope() {
  return browserTransport()?.scope ?? 'local';
}

/** Captured target and admission: an old review cannot follow a host switch or reconnect. */
export function hostUpdateTransport(allowed: boolean) {
  const remote = browserTransport();
  const generation = remote?.generation;
  const path = remote ? '/api/host/updates' : '/frontend/updates';
  const current = () => {
    if (!allowed) throw new Error('Host updates require host-approved device access.');
    if (browserTransport() !== remote || remote?.generation !== generation)
      throw new Error('Host update connection changed. Refresh status before continuing.');
  };
  return async (request?: FrontendHostUpdateRequest, signal?: AbortSignal) => {
    current();
    if (remote && request) onlineHostUpdateRequestSchema.parse(request);
    let readPath = path;
    if (!request) {
      const supported =
        !remote ||
        supportsApplicationFeature(
          versionResponseSchema.parse(await api('GET', '/api/version', undefined, signal)).protocol,
          { major: 26, minor: 2 },
        );
      if (supported) readPath += '?components=1';
    }
    let result;
    try {
      result = request
        ? await api('POST', path, request, signal)
        : await api('GET', readPath, undefined, signal);
    } catch (error) {
      // An older connector/frontend may reject the additive query even with a new host.
      // Only the read is retried, never preparation or activation.
      if (
        request ||
        readPath === path ||
        !(error instanceof ApiError) ||
        ![400, 403].includes(error.status)
      )
        throw error;
      result = await api('GET', path, undefined, signal);
    }
    current();
    return result;
  };
}
