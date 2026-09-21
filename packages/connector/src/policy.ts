import {
  REMOTE_POLICY,
  createSessionRequestSchema,
  patchSessionRequestSchema,
  wsClientMessageSchema,
  type RemoteMessage,
  type WsClientMessage,
} from '@puddle/shared';

const hex = '[a-f0-9]{10}';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const routes: ReadonlyArray<readonly [string, RegExp, readonly string[]]> = [
  ['GET', /^\/api\/(version|host|config|agents|profiles|repos)$/, []],
  ['GET', /^\/api\/accounts$/, ['profile']],
  ['GET', new RegExp(`^/api/profiles/${hex}/(settings|state)$`), []],
  ['GET', /^\/api\/projects$/, ['profile']],
  ['GET', new RegExp(`^/api/projects/${hex}$`), []],
  ['GET', /^\/api\/sessions$/, ['project', 'profile', 'status']],
  ['GET', new RegExp(`^/api/sessions/${uuid}$`), []],
  ['GET', /^\/api\/repos\/[0-9]+\/(branches|worktrees)$/, []],
  ['POST', /^\/api\/sessions$/, []],
  ['PATCH', new RegExp(`^/api/sessions/${uuid}$`), []],
  ['POST', new RegExp(`^/api/sessions/${uuid}/(resume|kill|archive|unarchive)$`), []],
  ['POST', new RegExp(`^/api/projects/${hex}/conversations/refresh$`), []],
  ['GET', new RegExp(`^/api/worktrees/${uuid}/(tree|file|resolve)$`), ['path']],
  [
    'GET',
    new RegExp(
      `^/api/worktrees/${uuid}/(diff|git-status|git-repositories|index-file|git-original|file-at|log)$`,
    ),
    ['path', 'root', 'against', 'area', 'ref', 'limit', 'skip'],
  ],
  ['GET', new RegExp(`^/api/worktrees/${uuid}/show/[a-f0-9]{4,40}$`), ['root']],
];

/** This table is the entire remote HTTP surface. No prefix-based forwarding. */
export function permittedRequest(message: Extract<RemoteMessage, { t: 'request' }>): {
  method: string;
  path: string;
  body?: string;
} {
  // eslint-disable-next-line no-control-regex -- Reject control characters at the trust boundary.
  if (!message.path.startsWith('/api/') || /[\\#\u0000-\u0020]/.test(message.path))
    throw new Error('Remote operation is not available');
  const url = new URL(message.path, 'http://127.0.0.1');
  // Reject normalisation tricks instead of checking one path and sending another.
  if (url.origin !== 'http://127.0.0.1' || url.pathname !== message.path.split('?')[0])
    throw new Error('Invalid remote path');
  const route = routes.find(
    ([method, pattern]) => method === message.method && pattern.test(url.pathname),
  );
  if (!route) throw new Error('Remote operation is not available');
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !route[2].includes(key)))
    throw new Error('Invalid remote parameters');
  let body: unknown;
  if (message.method === 'POST' && url.pathname === '/api/sessions')
    body = createSessionRequestSchema.parse(message.body);
  else if (message.method === 'PATCH') body = patchSessionRequestSchema.parse(message.body);
  else if (message.body !== undefined) throw new Error('This operation has no request body');
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && Buffer.byteLength(encoded) > REMOTE_POLICY.requestBytes)
    throw new Error('Request is too large');
  return { method: message.method, path: url.pathname + url.search, body: encoded };
}

/** Remote terminals address placements only: no account-login or home stream. */
export function permittedTerminal(value: unknown): WsClientMessage {
  const message = wsClientMessageSchema.parse(value);
  switch (message.t) {
    case 'attach':
    case 'stdin':
    case 'resize':
    case 'detach':
    case 'spawn-shell':
    case 'kill-shell':
    case 'subscribe-status':
    case 'theme':
      break;
    default:
      // A new daemon message must receive an explicit remote policy review.
      throw new Error('Remote terminal operation is not available');
  }
  if ('session' in message && !new RegExp(`^${uuid}$`).test(message.session))
    throw new Error('A placement terminal is required');
  if (message.t === 'stdin' && Buffer.byteLength(message.data) > REMOTE_POLICY.requestBytes)
    throw new Error('Terminal input is too large');
  return message;
}
