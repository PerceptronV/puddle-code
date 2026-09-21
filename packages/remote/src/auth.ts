import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import type { RemoteConfig } from './config.js';
import type { ServiceStore } from './store.js';
import { RateLimit } from './rate-limit.js';

export interface ServiceSession {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
  };
  session: { id: string; token: string; expiresAt: Date };
}
export interface ServiceAuth {
  session(headers: Headers): Promise<ServiceSession | null>;
  authorised(headers: Headers): Promise<ServiceSession | null>;
  handle(request: Request): Promise<Response>;
}
export async function createServiceAuth(
  config: RemoteConfig,
  store: ServiceStore,
): Promise<ServiceAuth> {
  const options = {
    appName: 'Puddle',
    baseURL: config.service,
    secret: config.secret,
    database: store.db,
    trustedOrigins: [config.app, config.service],
    socialProviders: {
      ...(config.google ? { google: { ...config.google, disableIdTokenSignIn: true } } : {}),
      ...(config.github ? { github: config.github } : {}),
    },
    user: {
      // Check the current provider claim on every sign-in, including existing users.
      validateUserInfo: async ({ user }) => {
        if (user.emailVerified !== true)
          return {
            error: 'email_not_verified',
            errorDescription: 'Verify your email with your login provider first',
          };
      },
    },
    onAPIError: { errorURL: config.app },
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: 7 * 24 * 60 * 60, cookieCache: { enabled: false } },
    // Disable Better Auth's automatic __Secure- prefix so the browser enforces
    // __Host- semantics; Secure itself remains mandatory on every cookie.
    advanced: {
      useSecureCookies: false,
      cookiePrefix: '__Host-puddle',
      defaultCookieAttributes: {
        secure: true,
        httpOnly: true,
        sameSite: 'lax' as const,
        path: '/',
      },
      ipAddress: { ipAddressHeaders: ['x-puddle-peer-ip'] },
    },
    rateLimit: { enabled: true, storage: 'database' as const, window: 60, max: 30 },
    plugins: [twoFactor({ allowPasswordless: true })],
    logger: { disabled: true },
  } satisfies BetterAuthOptions;
  const migrations = await getMigrations(options);
  await migrations.runMigrations();
  // Retire credentials from earlier builds without relinking accounts by email.
  // Existing provider bindings and host ownership survive; all old sessions end.
  store.db.transaction(() => {
    if (!store.db.prepare("SELECT 1 FROM account WHERE providerId = 'credential'").get()) return;
    store.db.exec(
      "DELETE FROM account WHERE providerId = 'credential'; DELETE FROM session; DELETE FROM verification; DELETE FROM mfa_sessions;",
    );
  })();
  const auth = betterAuth(options);
  const mfaAttempts = new RateLimit(5);
  const session = async (headers: Headers): Promise<ServiceSession | null> => {
    const result = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!result) return null;
    return {
      session: result.session,
      user: {
        ...result.user,
        twoFactorEnabled:
          'twoFactorEnabled' in result.user && result.user.twoFactorEnabled === true,
      },
    };
  };
  const authorised = async (headers: Headers) => {
    const current = await session(headers);
    if (
      !current?.user.emailVerified ||
      (current.user.twoFactorEnabled && !store.hasMfa(current.session.token))
    )
      return null;
    return current;
  };
  const handle = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname.slice('/api/auth'.length);
    // Expose only the authentication flows Puddle uses. In particular, Better
    // Auth's built-in password/email endpoints must never become reachable.
    const publicFlow =
      /^(\/get-session|\/sign-out|\/sign-in\/social|\/callback\/(google|github)|\/two-factor\/verify-(totp|backup-code))$/;
    const securityFlow = /^\/two-factor\/(enable|disable)$/;
    if (!publicFlow.test(path) && !securityFlow.test(path))
      return Response.json({ message: 'Unknown authentication endpoint' }, { status: 404 });
    const current = await session(request.headers);
    if (
      request.method === 'POST' &&
      /^\/two-factor\/verify-/.test(path) &&
      !mfaAttempts.take(current?.user.id ?? request.headers.get('x-puddle-peer-ip') ?? 'unknown')
    )
      return Response.json(
        { message: 'Too many verification attempts. Wait a minute.' },
        { status: 429 },
      );
    // Social logins can issue a session before optional MFA. Such a session cannot
    // alter account security, register a host, or open a relay pipe.
    if (
      current?.user.twoFactorEnabled &&
      !store.hasMfa(current.session.token) &&
      !publicFlow.test(path)
    )
      return Response.json({ message: 'Complete two-factor verification first' }, { status: 403 });
    const response = await auth.handler(request);
    if (response.ok && /^\/two-factor\/verify-(totp|backup-code)$/.test(path)) {
      // The token comes from Better Auth's successful verification response, never the request.
      const body: unknown = await response.clone().json();
      if (
        typeof body === 'object' &&
        body !== null &&
        'token' in body &&
        typeof body.token === 'string'
      ) {
        const verified = store.db
          .prepare('SELECT userId, expiresAt FROM session WHERE token = ?')
          .get(body.token) as { userId: string; expiresAt: number | string } | undefined;
        if (verified)
          store.markMfa(body.token, verified.userId, new Date(verified.expiresAt).getTime());
      }
      // Initial TOTP enrolment rotates the session cookie, while Better Auth's
      // response body can still name the previous (now deleted) session. Resolve
      // its freshly issued signed cookie through Better Auth, never by decoding it.
      const issued = response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; ');
      if (issued) {
        const replacement = await session(new Headers({ cookie: issued }));
        if (replacement)
          store.markMfa(
            replacement.session.token,
            replacement.user.id,
            replacement.session.expiresAt.getTime(),
          );
      }
    }
    if (response.ok && current && /^\/two-factor\/(enable|disable)$/.test(path))
      store.clearMfa(current.user.id);
    return response;
  };
  return { session, authorised, handle };
}
