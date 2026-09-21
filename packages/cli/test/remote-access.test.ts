import { describe, expect, it, vi } from 'vitest';
import { RemoteAccessControl } from '../src/lib/remote-access.js';
import type { ExecOptions, Transport } from '../src/lib/transport/transport.js';

function fixture() {
  const exec = vi.fn(async (_command: string, _options?: ExecOptions) => ({
    code: 0,
    stdout: 'cockpit controls 1',
    stderr: '',
  }));
  const transport: Transport = {
    kind: 'ssh',
    label: 'owner@example.test',
    exec,
    readFile: async () => null,
    copyTo: async () => {},
    dispose() {},
  };
  return { exec, control: new RemoteAccessControl(transport) };
}

describe('desktop remote control boundary', () => {
  it('passes registration secrets only through stdin and uses managed supervision', async () => {
    const { exec, control } = fixture();
    exec.mockResolvedValueOnce({ code: 0, stdout: 'cockpit controls 1', stderr: '' });
    exec.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ enabled: true }), stderr: '' });
    const registration = {
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
      code: 'a'.repeat(64),
    };
    await control.request({ t: 'enable', registration }, () => true);
    const [command, options] = exec.mock.calls[1]!;
    expect(command).toMatch(/--configure$/);
    expect(command).not.toContain(registration.service);
    expect(command).not.toContain(registration.code);
    expect(JSON.parse(options!.stdin!)).toEqual({ ...registration, managed: true });
  });

  it('rechecks browser authority after asynchronous host discovery', async () => {
    const { exec, control } = fixture();
    await expect(control.request({ t: 'disable' }, () => false)).rejects.toThrow(
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
    expect((await control.status()).availability).toBe('upgrade_required');
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockResolvedValueOnce({ code: 0, stdout: 'cockpit controls 1', stderr: '' });
    exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'private-routing-credential' });
    await expect(control.request({ t: 'pair' }, () => true)).rejects.toThrow('Refresh status');
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
        control.request(request as Parameters<typeof control.request>[0], () => true),
      ).rejects.toThrow();
    }
    expect(exec).not.toHaveBeenCalled();
  });
});
