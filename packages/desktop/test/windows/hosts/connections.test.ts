import { describe, expect, it, vi } from 'vitest';
import { HostConnections, type WindowCockpit } from '../../../src/windows/hosts/connections.js';

function cockpit(port = 7433) {
  return { origin: `http://localhost:${port}`, stop: vi.fn().mockResolvedValue(undefined) };
}

describe('host connection ownership across independent windows', () => {
  it('shares one pending connection and stops only after its final window closes', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof cockpit>>();
    const connect = vi.fn(() => pending.promise);
    const registry = new HostConnections<WindowCockpit, string>(connect);
    const host = registry.open('host', 'host-window', () => 'host');
    const project = registry.open('host', 'project-window', () => 'project');
    const pane = registry.open('host', 'pane-window', () => 'pane');
    await Promise.resolve();
    expect(connect).toHaveBeenCalledOnce();
    const connection = cockpit();
    pending.resolve(connection);
    expect(await Promise.all([host, project, pane])).toEqual(['host', 'project', 'pane']);
    await registry.close('host', 'host-window');
    expect(connection.stop).not.toHaveBeenCalled();
    await registry.close('host', 'project-window');
    expect(connection.stop).not.toHaveBeenCalled();
    await registry.close('host', 'pane-window');
    expect(connection.stop).toHaveBeenCalledOnce();
  });

  it('creates a restored pane without a host window and deduplicates repeated opens', async () => {
    const connection = cockpit();
    const registry = new HostConnections<WindowCockpit, string>(async () => connection);
    const create = vi.fn(() => 'pane');
    expect(
      await Promise.all([
        registry.open('host', 'pane', create),
        registry.open('host', 'pane', create),
      ]),
    ).toEqual(['pane', 'pane']);
    expect(create).toHaveBeenCalledOnce();
    expect([...registry.hosts.get('host')!.windows.keys()]).toEqual(['pane']);
    await registry.dispose();
    expect(connection.stop).toHaveBeenCalledOnce();
  });

  it('shares refresh and reports the replacement to all remaining windows', async () => {
    const first = cockpit();
    const second = cockpit(7435);
    const replacement = Promise.withResolvers<ReturnType<typeof cockpit>>();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => replacement.promise);
    const registry = new HostConnections<WindowCockpit, string>(connect);
    await registry.open('host', 'host', () => 'host');
    await registry.open('host', 'pane', () => 'pane');
    const host = registry.hosts.get('host')!;
    const changed = vi.fn();
    const refresh = registry.refresh(host, 'refresh-id', changed);
    expect(registry.refresh(host, 'another-id', changed)).toBe(refresh);
    await registry.close('host', 'host');
    replacement.resolve(second);
    await refresh;
    expect(connect).toHaveBeenLastCalledWith('host', first, 'refresh-id');
    expect(changed).toHaveBeenCalledExactlyOnceWith(first);
    expect(host.cockpit).toBe(second);
    expect([...host.windows.keys()]).toEqual(['pane']);
    await registry.dispose();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it('stops a replacement arriving after the last window closes', async () => {
    const first = cockpit();
    const second = cockpit(7435);
    const replacement = Promise.withResolvers<ReturnType<typeof cockpit>>();
    const started = Promise.withResolvers<void>();
    const registry = new HostConnections<WindowCockpit, string>(async (_target, previous) => {
      if (!previous) return first;
      started.resolve();
      return replacement.promise;
    });
    await registry.open('host', 'pane', () => 'pane');
    const changed = vi.fn();
    const refresh = registry.refresh(registry.hosts.get('host')!, undefined, changed);
    await started.promise;
    const closed = registry.close('host', 'pane');
    replacement.resolve(second);
    await Promise.all([refresh, closed]);
    expect(changed).not.toHaveBeenCalled();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(registry.has('host')).toBe(false);
  });

  it('does not reconnect when the last window closes while the old cockpit stops', async () => {
    const stopping = Promise.withResolvers<void>();
    const first = { origin: 'http://localhost:7433', stop: vi.fn(() => stopping.promise) };
    const connect = vi.fn(async () => first);
    const registry = new HostConnections<WindowCockpit, string>(connect);
    await registry.open('host', 'pane', () => 'pane');
    const refresh = registry.refresh(registry.hosts.get('host')!);
    const closed = registry.close('host', 'pane');
    stopping.resolve();
    await Promise.all([refresh, closed]);
    expect(connect).toHaveBeenCalledOnce();
    expect(first.stop).toHaveBeenCalledOnce();
  });

  it('waits for retirement before opening another cockpit for the same host', async () => {
    const stopping = Promise.withResolvers<void>();
    const first = { origin: 'http://localhost:7433', stop: vi.fn(() => stopping.promise) };
    const second = cockpit();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const registry = new HostConnections<WindowCockpit, string>(connect);
    await registry.open('host', 'pane', () => 'pane');
    const closed = registry.close('host', 'pane');
    const opened = registry.open('host', 'host', () => 'host');
    await Promise.resolve();
    expect(connect).toHaveBeenCalledOnce();
    stopping.resolve();
    await closed;
    expect(await opened).toBe('host');
    expect(connect).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it('disposes late initial connections without creating a window', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof cockpit>>();
    const connection = cockpit();
    const registry = new HostConnections<WindowCockpit, string>(() => pending.promise);
    const create = vi.fn(() => 'pane');
    const opened = registry.open('host', 'pane', create);
    await Promise.resolve();
    const disposed = registry.dispose();
    pending.resolve(connection);
    await disposed;
    expect(await opened).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(connection.stop).toHaveBeenCalledOnce();
    expect(await registry.open('host', 'other', create)).toBeUndefined();
  });

  it('keeps other hosts independent and cleans up failed window creation', async () => {
    const first = cockpit();
    const second = cockpit(7435);
    const registry = new HostConnections<WindowCockpit, string>(async (target) =>
      target === 'a' ? first : second,
    );
    await registry.open('a', 'pane-a', () => 'a');
    await expect(
      registry.open('b', 'pane-b', () => {
        throw new Error('creation failed');
      }),
    ).rejects.toThrow('creation failed');
    expect(first.stop).not.toHaveBeenCalled();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(registry.has('a')).toBe(true);
    expect(registry.has('b')).toBe(false);
    await registry.dispose();
  });
});
