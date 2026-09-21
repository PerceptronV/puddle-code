import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { remoteOriginSchema } from '@puddle/shared';

// A build-time trust decision. An invitation cannot choose who serves authentication.
export const serviceOrigin = remoteOriginSchema.parse(import.meta.env.VITE_PUDDLE_REMOTE_SERVICE);
export const authClient = createAuthClient({
  baseURL: serviceOrigin,
  plugins: [twoFactorClient()],
  fetchOptions: { credentials: 'include' },
});
export async function serviceRequest(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(path, serviceOrigin), {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Remote service request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

export function authResult<T>(result: { data: T; error: { message?: string } | null }): T {
  if (result.error) throw new Error(result.error.message ?? 'Authentication failed');
  return result.data;
}
