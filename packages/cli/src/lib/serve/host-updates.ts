import type { IncomingMessage, ServerResponse } from 'node:http';
import { cockpitHostUpdateQuerySchema, cockpitHostUpdateRequestSchema } from '@puddle/shared';
import type { CockpitHostUpdates } from '../host/updates/cockpit.js';
import { fail, json, readJson } from './http-auth.js';

/** Behind exact cockpit Host/Origin and browser authority; reads remain usable during staging. */
export function hostUpdatesHandler(control: CockpitHostUpdates | undefined) {
  let mutating = false;
  let readers = 0;
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    authorised: () => boolean,
    signal: AbortSignal,
  ) => {
    if (!control) return fail(res, 404, 'host_updates_unavailable');
    if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    const url = new URL(req.url!, 'http://localhost');
    const query = cockpitHostUpdateQuerySchema.parse(Object.fromEntries(url.searchParams));
    if (
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length > 1) ||
      (req.method === 'POST' && url.search)
    )
      return fail(res, 400, 'bad_request');
    const request =
      req.method === 'POST' ? cockpitHostUpdateRequestSchema.parse(await readJson(req)) : null;
    if (!authorised()) return fail(res, 401, 'browser_rejected');
    if (request && mutating)
      return fail(res, 409, 'host_update_busy', 'An update action is already in progress.');
    if (!request && readers >= 4)
      return fail(res, 409, 'host_update_busy', 'Host update status is already being read.');
    if (request) mutating = true;
    else readers++;
    try {
      const result = request
        ? await control.request(request, authorised, signal)
        : await control.status(query.id, authorised, signal, query.components === '1');
      if (!authorised()) return fail(res, 401, 'browser_rejected');
      json(res, 200, result);
    } catch {
      // Installer/SSH output may contain private paths or credentials. Observe after loss.
      fail(
        res,
        503,
        'host_update_unavailable',
        'Host update response is unavailable. Refresh status before another action.',
      );
    } finally {
      if (request) mutating = false;
      else readers--;
    }
  };
}
