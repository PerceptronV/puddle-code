import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import QRCode from 'qrcode';
import { REMOTE_PROTOCOL_VERSION, remoteInvitationSchema } from '@puddle/shared';

export const service = 'https://relay.example.test';
export const account = 'pairing-reader';
export const host = '00000000-0000-4000-8000-000000000001';
export function pairingLink(origin: string) {
  const invitation = remoteInvitationSchema.parse({
    version: REMOTE_PROTOCOL_VERSION,
    service,
    host,
    peer: 'A'.repeat(44),
    invitation: 'b'.repeat(64),
    expires: Date.now() + 300_000,
  });
  return `${origin}/remote/pair#pair=${encodeURIComponent(JSON.stringify(invitation))}`;
}

export async function startPairingFixture() {
  const caddy = await readFile(
    fileURLToPath(new URL('../../../deploy/remote/Caddyfile.app', import.meta.url)),
    'utf8',
  );
  const policy = /header @application \{\s*Permissions-Policy "([^"]+)"/.exec(caddy)?.[1];
  if (!policy) throw new Error('Missing application camera policy');
  // Actual remote UI and QR decoding, isolated from host daemons and camera hardware.
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.build.config.ts', import.meta.url)),
    define: { 'import.meta.env.VITE_PUDDLE_REMOTE_SERVICE': JSON.stringify(service) },
    server: { host: '127.0.0.1', port: 0, headers: { 'Permissions-Policy': policy } },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

export async function mockPairingAccount(page: Page) {
  await page.route(`${service}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/remote/config')
      return route.fulfill({ json: { providers: ['github'], protocol: REMOTE_PROTOCOL_VERSION } });
    if (path === '/remote/me')
      return route.fulfill({
        json: {
          user: {
            id: account,
            name: 'Reader',
            email: 'reader@example.test',
            emailVerified: true,
            twoFactorEnabled: false,
          },
          mfaRequired: false,
        },
      });
    if (path === '/remote/hosts')
      return route.fulfill({ json: [{ id: host, label: 'Test host', online: false }] });
    return route.abort();
  });
  await page.routeWebSocket(`${service.replace('https:', 'wss:')}/**`, (socket) => socket.close());
}

export async function fakeCamera(
  page: Page,
  link: string,
  mode: 'qr' | 'blank' | 'denied' | 'pending' = 'qr',
) {
  const image = await QRCode.toDataURL(link, { width: 640, margin: 4 });
  await page.evaluate(
    async ({ image, mode }) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 640;
      const picture = new Image();
      picture.src = image;
      await picture.decode();
      if (mode === 'qr') canvas.getContext('2d')!.drawImage(picture, 0, 0);
      const stream = canvas.captureStream(5);
      document.documentElement.dataset.cameraRequests = '0';
      document.documentElement.dataset.cameraStops = '0';
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          document.documentElement.dataset.cameraStops = String(
            Number(document.documentElement.dataset.cameraStops) + 1,
          );
          stop();
        };
      }
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: () => {
          document.documentElement.dataset.cameraRequests = String(
            Number(document.documentElement.dataset.cameraRequests) + 1,
          );
          if (mode === 'denied')
            return Promise.reject(new DOMException('Denied', 'NotAllowedError'));
          if (mode === 'pending')
            return new Promise<MediaStream>((resolve) => {
              document.addEventListener('fixture-camera-granted', () => resolve(stream), {
                once: true,
              });
            });
          return Promise.resolve(stream);
        },
      });
    },
    { image, mode },
  );
}

export async function savedIdentity(page: Page) {
  return page.evaluate(
    async ({ service, account, host }) => {
      const moduleUrl = new URL('/src/features/remote/identity-store.ts', location.origin).href;
      const { loadBrowserHost } = await import(moduleUrl);
      return loadBrowserHost(service, account, host) as Promise<{
        privateKey: number[];
        label: string;
      } | null>;
    },
    { service, account, host },
  );
}
