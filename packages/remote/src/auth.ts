import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import nodemailer from 'nodemailer';
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
  deliver?: (to: string, subject: string, url: string) => Promise<void>,
): Promise<ServiceAuth> {
  const mail = nodemailer.createTransport(config.smtp, { requireTLS: true });
  const send =
    deliver ??
    (async (to: string, subject: string, url: string) => {
      await mail.sendMail({
        from: config.from,
        to,
        subject,
        text: `${subject}\n\n${url}\n\nIf you did not request this, ignore this message.`,
      });
    });
  const options = {
    appName: 'Puddle',
    baseURL: config.service,
    secret: config.secret,
    database: store.db,
    trustedOrigins: [config.app, config.service],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) =>
        send(user.email, 'Reset your Puddle password', url),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) =>
        send(user.email, 'Verify your Puddle email', url),
    },
    socialProviders: {
      ...(config.google ? { google: config.google } : {}),
      ...(config.github ? { github: config.github } : {}),
    },
    account: { accountLinking: { enabled: true, disableImplicitLinking: true } },
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
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => {
            if (!config.openSignup && !config.signupEmails.includes(user.email.toLowerCase()))
              throw new APIError('FORBIDDEN', {
                message: 'Registration is not enabled for this email',
              });
          },
        },
      },
    },
    plugins: [twoFactor({ allowPasswordless: true })],
    logger: { disabled: true },
  };
  const migrations = await getMigrations(options);
  await migrations.runMigrations();
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
    // alter account security, link providers, register a host, or open a relay pipe.
    const publicFlow =
      /^(\/get-session|\/sign-out|\/sign-in\/(email|social)|\/callback\/(google|github)|\/two-factor\/verify-(totp|backup-code)|\/request-password-reset|\/reset-password|\/verify-email|\/send-verification-email)$/;
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
