import { expect, it, vi } from 'vitest';
import { hostReleaseCapabilities, PROTOCOL_VERSION } from '@puddle/shared';
import { requireHostPurgeSupport } from '../../../src/lib/installation/host/purge.js';
import type { Transport } from '../../../src/lib/transport/transport.js';

function fixture(application: { major: number; minor: number } | null) {
  const capabilities = hostReleaseCapabilities('0.4.0');
  if (application) capabilities.application = application;
  const exec = vi.fn<Transport['exec']>(async () => ({
    code: application ? 0 : 3,
    stdout: application ? JSON.stringify(capabilities) : '',
    stderr: '',
  }));
  const transport: Transport = {
    kind: 'local',
    label: 'synthetic host',
    exec,
    readFile: async () => null,
    copyTo: async () => undefined,
    dispose() {},
  };
  return { transport, exec };
}

it.each([
  null,
  { major: 25, minor: 19 },
  { major: 25, minor: 20 },
  { major: PROTOCOL_VERSION.major + 1, minor: 0 },
])(
  'explains the purge capability boundary for %j without executing a helper',
  async (application) => {
    const f = fixture(application);
    await expect(requireHostPurgeSupport(f.transport)).rejects.toMatchObject({
      code: 'upgrade_failed',
      message: 'This host does not support coordinated data purge',
      hint: expect.stringMatching(
        /introduced in application 25\.20.*compatible with this CLI.*retain data/,
      ),
    });
    expect(f.exec).toHaveBeenCalledTimes(1);
    expect(f.exec.mock.calls[0]![0]).toContain('HOST_CAPABILITIES.json');
    expect(f.exec.mock.calls[0]![0]).not.toContain('host-update.mjs');
  },
);

it.each([{ major: PROTOCOL_VERSION.major, minor: 0 }, PROTOCOL_VERSION])(
  'admits supporting purge capability %j without starting removal',
  async (application) => {
    const f = fixture(application);
    await expect(requireHostPurgeSupport(f.transport)).resolves.toBeUndefined();
    expect(f.exec).toHaveBeenCalledTimes(1);
    expect(f.exec.mock.calls[0]![0]).toContain('HOST_CAPABILITIES.json');
  },
);
