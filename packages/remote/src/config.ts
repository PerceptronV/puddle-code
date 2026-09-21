import { getDomain } from 'tldts';
import { remoteOriginSchema } from '@puddle/shared';

export interface RemoteConfig {
  service: string;
  app: string;
  home: string;
  address: string;
  port: number;
  secret: string;
  smtp: string;
  from: string;
  signupEmails: string[];
  openSignup: boolean;
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
}

export function readConfig(env: NodeJS.ProcessEnv): RemoteConfig {
  const service = remoteOriginSchema.parse(env.PUDDLE_REMOTE_SERVICE);
  const app = remoteOriginSchema.parse(env.PUDDLE_REMOTE_APP);
  const serviceDomain = getDomain(new URL(service).hostname);
  if (app === service || !serviceDomain || serviceDomain !== getDomain(new URL(app).hostname))
    throw new Error('Application and service require separate HTTPS origins under the same site');
  const secret = env.BETTER_AUTH_SECRET ?? '';
  if (secret.length < 32 || secret.startsWith('replace-with-'))
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 random characters');
  const smtp = env.PUDDLE_SMTP_URL ?? '';
  if (!/^smtps?:\/\//.test(smtp) || !env.PUDDLE_EMAIL_FROM)
    throw new Error('SMTP delivery and sender configuration are required');
  const port = Number(env.PORT ?? 7440);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service port');
  const provider = (name: string) => {
    const clientId = env[`${name}_CLIENT_ID`];
    const clientSecret = env[`${name}_CLIENT_SECRET`];
    if (!!clientId !== !!clientSecret) throw new Error(`${name} requires both OAuth credentials`);
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };
  return {
    service,
    app,
    secret,
    smtp,
    from: env.PUDDLE_EMAIL_FROM,
    port,
    home: env.PUDDLE_REMOTE_HOME ?? '/var/lib/puddle-remote',
    address: env.HOST ?? '127.0.0.1',
    signupEmails: (env.PUDDLE_SIGNUP_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    openSignup: env.PUDDLE_OPEN_SIGNUP === 'true',
    google: provider('GOOGLE'),
    github: provider('GITHUB'),
  };
}
