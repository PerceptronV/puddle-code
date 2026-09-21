import { createHash, randomUUID } from 'node:crypto';
import type { ServiceAuth } from '../../src/auth.js';
import type { RemoteConfig } from '../../src/config.js';

interface Identity {
  email: string;
  verified?: boolean;
  id?: string;
}

export function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

/** Fixture only at GitHub's network boundary: Better Auth owns state, callbacks and cookies. */
export function githubFixture() {
  const original = globalThis.fetch;
  const codes = new Map<string, Identity>();
  const tokens = new Map<string, Identity>();
  let attempt = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== 'https://github.com' && url.origin !== 'https://api.github.com')
      return original(input, init);
    const request = new Request(input, init);
    if (url.href === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(await request.text());
      const code = body.get('code') ?? '';
      const identity = codes.get(code);
      codes.delete(code);
      if (!identity) return Response.json({ error: 'bad_verification_code' }, { status: 400 });
      const token = randomUUID();
      tokens.set(token, identity);
      return Response.json({
        access_token: token,
        token_type: 'bearer',
        scope: 'read:user,user:email',
      });
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
    const identity = tokens.get(token);
    if (!identity) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    if (url.href === 'https://api.github.com/user')
      return Response.json({
        id: identity.id ?? createHash('sha256').update(identity.email).digest('hex'),
        name: 'Owner',
        login: 'fixture',
        email: null, // Exercise GitHub's private primary email lookup.
      });
    if (url.href === 'https://api.github.com/user/emails')
      return Response.json([
        { email: identity.email, primary: true, verified: identity.verified ?? true },
      ]);
    throw new Error(`Unexpected OAuth fixture request: ${url.origin}${url.pathname}`);
  };
  const callback = (authorisation: string, identity: Identity) => {
    const url = new URL(authorisation);
    if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize')
      throw new Error('Expected GitHub authorisation');
    const result = new URL(url.searchParams.get('redirect_uri')!);
    const code = randomUUID();
    codes.set(code, identity);
    result.searchParams.set('code', code);
    result.searchParams.set('state', url.searchParams.get('state')!);
    return result.toString();
  };
  return {
    callback,
    async login(
      auth: ServiceAuth,
      config: Pick<RemoteConfig, 'service' | 'app'>,
      identity: Identity,
    ) {
      const start = await auth.handle(
        new Request(config.service + '/api/auth/sign-in/social', {
          method: 'POST',
          headers: {
            origin: config.app,
            'content-type': 'application/json',
            'x-puddle-peer-ip': `192.0.2.${++attempt}`,
          },
          body: JSON.stringify({ provider: 'github', callbackURL: config.app }),
        }),
      );
      if (!start.ok) throw new Error(`OAuth start failed: ${await start.text()}`);
      const { url } = (await start.json()) as { url: string };
      return auth.handle(
        new Request(callback(url, identity), { headers: { cookie: cookies(start) } }),
      );
    },
    close() {
      globalThis.fetch = original;
    },
  };
}
