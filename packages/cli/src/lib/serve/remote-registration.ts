import type { IncomingMessage, ServerResponse } from 'node:http';
import { cockpitRegistrationCheckSchema, registrationStatusSchema } from '@puddle/shared';
import { fail, json, readJson } from './http-auth.js';

/** Behind the cockpit's exact Host/Origin and browser authorisation checks. */
export async function checkRemoteRegistration(
  req: IncomingMessage,
  res: ServerResponse,
  authorised: () => boolean,
) {
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
  const { service, code } = cockpitRegistrationCheckSchema.parse(await readJson(req));
  if (!authorised()) return fail(res, 401, 'browser_rejected');
  try {
    const response = await fetch(`${service}/remote/registration-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Service unavailable');
    }
    let body = '';
    for await (const chunk of response.body ?? []) {
      body += Buffer.from(chunk).toString('utf8');
      if (body.length > 1024) throw new Error('Response too large');
    }
    const status = registrationStatusSchema.parse(JSON.parse(body));
    if (!authorised()) return fail(res, 401, 'browser_rejected');
    json(res, 200, status);
  } catch {
    fail(
      res,
      503,
      'registration_unavailable',
      'Could not check browser sign-in. Check the relay address and update the deployed service, then try again.',
    );
  }
}
