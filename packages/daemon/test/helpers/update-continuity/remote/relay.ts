import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRemoteService } from '../../../../../remote/src/server.js';
import { githubFixture, cookies } from '../../../../../remote/test/helpers/oauth.js';
import { findFreePort } from '../../../../../cli/src/lib/transport/net.js';

/** Reuse the mobile acceptance TLS splice and real relay/auth; no browser build or unmanaged connector. */
export async function continuityRelay(home: string) {
  const directory = join(home, 'test-relay');
  mkdirSync(directory, { mode: 0o700 });
  const port = await findFreePort();
  const service = `https://localhost:${port}`;
  const app = 'https://app.example.test';
  const certPath = join(directory, 'cert.pem');
  const keyPath = join(directory, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
  const github = githubFixture();
  const remote = await startRemoteService({
    service,
    app,
    home: join(directory, 'service'),
    address: '127.0.0.1',
    port: 0,
    secret: 'isolated-continuity-test-secret-long-enough-for-auth',
    github: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
  });
  const address = remote.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture relay address');
  const sockets = new Set<Duplex>();
  const relay = createServer(
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    (req, res) => {
      const upstream = request(
        {
          host: '127.0.0.1',
          port: address.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode!, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    },
  );
  relay.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  relay.on('upgrade', (req, socket, head) => {
    const upstream = connect(address.port, '127.0.0.1', () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
          req.rawHeaders.reduce(
            (text, part, index) => text + part + (index % 2 ? '\r\n' : ': '),
            '',
          ) +
          '\r\n',
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => relay.listen(port, '127.0.0.1', resolve));
  const signedIn = await github.login(
    remote.auth,
    { service, app },
    { email: 'continuity@example.test' },
  );
  const cookie = cookies(signedIn);
  const session = await remote.auth.authorised(new Headers({ cookie }));
  if (!session) throw new Error('Fixture service login failed');
  const registration = remote.store.redeem(
    remote.store.register(session.user.id, 'Continuity host').code,
  );
  return {
    service,
    app,
    certPath,
    cookie,
    registration,
    online: () => remote.relay.online(registration.host),
    async close() {
      github.close();
      for (const socket of sockets) socket.destroy();
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await remote.close();
    },
  };
}
