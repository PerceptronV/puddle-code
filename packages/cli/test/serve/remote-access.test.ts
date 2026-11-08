const profile = 'a'.repeat(10);
import { describe, expect, it, vi } from 'vitest';
import { RemoteAccessControl } from '../../src/lib/host/remote-access.js';
import type { ExecOptions, Transport } from '../../src/lib/transport/transport.js';

function fixture(kind: 'local' | 'ssh' = 'ssh') {
  const exec = vi.fn(async (_command: string, _options?: ExecOptions) => ({
    code: 0,
    stdout: 'frontend controls 2',
    stderr: '',
  }));
  const transport: Transport = {
    kind,
    label: 'owner@example.test',
    exec,
    readFile: async () => null,
    copyTo: async () => {},
    dispose() {},
  };
  return { exec, control: new RemoteAccessControl(transport) };
}

describe('desktop remote control boundary', () => {
  it.each(['local', 'ssh'] as const)(
    'gates host maintenance on the %s connector capability and current browser authority',
    async (kind) => {
      const { exec, control } = fixture(kind);
      const request = { t: 'maintenance', id: crypto.randomUUID(), enabled: true } as const;
      await expect(control.request(request, () => true, profile)).rejects.toThrow(
        'Upgrade the daemon',
      );
      expect(exec).toHaveBeenCalledTimes(1);
      exec.mockResolvedValue({
        code: 0,
        stdout: 'frontend controls 2; maintenance grants 1',
        stderr: '',
      });
      await expect(control.request(request, () => false, profile)).rejects.toThrow(
        'expired before dispatch',
      );
      expect(exec).toHaveBeenCalledTimes(2);
      exec.mockResolvedValueOnce({
        code: 0,
        stdout: 'frontend controls 2; maintenance grants 1',
        stderr: '',
      });
      exec.mockResolvedValueOnce({ code: 0, stdout: '{"devices":[]}', stderr: '' });
      await control.request(request, () => true, profile);
      const [command, options] = exec.mock.calls.at(-1)!;
      expect(command).toMatch(/--admin$/);
      expect(command).not.toContain(request.id);
      expect(JSON.parse(options!.stdin!)).toEqual({ profile, request });
    },
  );

  it('reports maintenance management only when the selected host connector advertises it', async () => {
    const { exec, control } = fixture();
    const status = {
      availability: 'ready',
      configured: false,
      enabled: false,
      connected: false,
      supervisor: null,
      devices: [],
    };
    for (const marker of ['frontend controls 2', 'cockpit controls 2']) {
      for (const supported of [false, true]) {
        exec.mockResolvedValueOnce({
          code: 0,
          stdout: `${marker}${supported ? '; maintenance grants 1' : ''}`,
          stderr: '',
        });
        exec.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(status), stderr: '' });
        expect((await control.status(profile)).canManageMaintenance).toBe(supported);
      }
    }
  });
  it('gates deletion by host capability and rechecks browser authority', async () => {
    const { exec, control } = fixture();
    await expect(
      control.request({ t: 'delete_registration' }, () => true, profile),
    ).rejects.toThrow('Upgrade the daemon');
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockResolvedValue({
      code: 0,
      stdout: 'frontend controls 2; delete registration 1',
      stderr: '',
    });
    await expect(
      control.request({ t: 'delete_registration' }, () => false, profile),
    ).rejects.toThrow('expired before dispatch');
    expect(exec).toHaveBeenCalledTimes(2);
    exec.mockResolvedValueOnce({
      code: 0,
      stdout: 'frontend controls 2; delete registration 1',
      stderr: '',
    });
    exec.mockResolvedValueOnce({
      code: 0,
      stdout: '{"enabled":false,"connected":false}',
      stderr: '',
    });
    await control.request({ t: 'delete_registration' }, () => true, profile);
    const [command, options] = exec.mock.calls.at(-1)!;
    expect(command).toMatch(/--admin$/);
    expect(JSON.parse(options!.stdin!)).toEqual({ profile, request: { t: 'delete_registration' } });
  });

  it('passes registration secrets only through stdin and uses managed supervision', async () => {
    const { exec, control } = fixture();
    exec.mockResolvedValueOnce({ code: 0, stdout: 'frontend controls 2', stderr: '' });
    exec.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ enabled: true }), stderr: '' });
    const registration = {
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
      code: 'a'.repeat(64),
    };
    await control.request({ t: 'enable', registration }, () => true, profile);
    const [command, options] = exec.mock.calls[1]!;
    expect(command).toMatch(/--configure$/);
    expect(command).not.toContain(registration.service);
    expect(command).not.toContain(registration.code);
    expect(JSON.parse(options!.stdin!)).toEqual({
      profile,
      setup: { ...registration, managed: true },
    });
  });

  it('rechecks browser authority after asynchronous host discovery', async () => {
    const { exec, control } = fixture();
    await expect(control.request({ t: 'disable' }, () => false, profile)).rejects.toThrow(
      'expired before dispatch',
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('does not invoke unsupported older connector flags or expose subprocess diagnostics', async () => {
    const { exec, control } = fixture();
    exec.mockResolvedValueOnce({
      code: 0,
      stdout: 'puddle-connector remote protocol 1',
      stderr: '',
    });
    expect((await control.status(profile)).availability).toBe('upgrade_required');
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockResolvedValueOnce({ code: 0, stdout: 'frontend controls 2', stderr: '' });
    exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'private-routing-credential' });
    await expect(control.request({ t: 'pair' }, () => true, profile)).rejects.toThrow(
      'Refresh status',
    );
  });

  it('rejects arbitrary commands, host overrides and foreground enablement', async () => {
    const { exec, control } = fixture();
    for (const request of [
      { t: 'run' },
      { t: 'disable', host: 'attacker.test' },
      { t: 'enable', managed: false },
    ]) {
      // Deliberate runtime boundary test: the caller is an untrusted JSON request.
      await expect(
        control.request(request as Parameters<typeof control.request>[0], () => true, profile),
      ).rejects.toThrow();
    }
    expect(exec).not.toHaveBeenCalled();
  });
});
