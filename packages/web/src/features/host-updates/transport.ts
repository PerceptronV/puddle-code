import { onlineHostUpdateRequestSchema, type CockpitHostUpdateRequest } from '@puddle/shared';
import { api } from '../../lib/transport/api';
import { browserTransport } from '../../lib/transport/browser-transport';

export function hostUpdateScope() {
  return browserTransport()?.scope ?? 'local';
}

/** Captured target and admission: an old review cannot follow a host switch or reconnect. */
export function hostUpdateTransport(allowed: boolean) {
  const remote = browserTransport();
  const generation = remote?.generation;
  const path = remote ? '/api/host/updates' : '/cockpit/updates';
  const current = () => {
    if (!allowed) throw new Error('Host updates require host-approved device access.');
    if (browserTransport() !== remote || remote?.generation !== generation)
      throw new Error('Host update connection changed. Refresh status before continuing.');
  };
  return async (request?: CockpitHostUpdateRequest, signal?: AbortSignal) => {
    current();
    if (remote && request) onlineHostUpdateRequestSchema.parse(request);
    const result = request
      ? await api('POST', path, request, signal)
      : signal
        ? await api('GET', path, undefined, signal)
        : await api('GET', path);
    current();
    return result;
  };
}
