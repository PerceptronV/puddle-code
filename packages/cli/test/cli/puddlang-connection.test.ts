import { beforeEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { connectPuddlang } from '../../src/puddlang/client.js';

const fixture = vi.hoisted(() => ({
  protocol: { major: 26, minor: 0 },
  close: vi.fn(),
  dispose: vi.fn(),
  open: vi.fn(),
  tunnelClose: vi.fn(),
  profiles: vi.fn(async () => [{ id: '1234567890', name: 'fixture' }]),
}));
// All OS authority and transports are replaced: these tests cannot contact an installed daemon.
vi.mock('../../src/lib/auth/connection-authority.js', () => ({
  acquireAuthority: vi.fn(async () => ({
    port: 12345,
    close: fixture.close,
    credential: () => 'fixture',
  })),
}));
vi.mock('../../src/lib/transport/local.js', () => ({
  LocalTransport: class {
    dispose = fixture.dispose;
  },
}));
vi.mock('../../src/lib/transport/ssh.js', () => ({
  SshTransport: class {
    open = fixture.open;
    dispose = fixture.dispose;
  },
}));
vi.mock('../../src/lib/transport/tunnel.js', () => ({
  openTunnel: vi.fn(async () => ({ localPort: 12346, close: fixture.tunnelClose })),
}));
vi.mock('../../src/lib/connection/daemon-client.js', () => ({
  DaemonClient: class {
    version = async () => ({ version: '0.4.0', protocol: fixture.protocol });
    profiles = fixture.profiles;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.protocol = { major: PROTOCOL_VERSION.major, minor: 0 };
});

it.each([undefined, 'fixture@host'])(
  'accepts compatible current-major daemons through existing local/SSH authority (%s)',
  async (host) => {
    const connection = await connectPuddlang(host, 'fixture');
    expect(connection.client.profile).toBe('1234567890');
    await expect(
      connection.client.outcomes('00000000-0000-4000-8000-000000000001'),
    ).rejects.toThrow(/26.1/);
    await connection.close();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
    if (host) expect(fixture.tunnelClose).toHaveBeenCalledOnce();
  },
);

it.each([24, 27])(
  'refuses incompatible major%s without profile access or implicit upgrade',
  async (major) => {
    fixture.protocol = { major, minor: 0 };
    await expect(connectPuddlang()).rejects.toThrow(/protocol/);
    expect(fixture.profiles).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  },
);
