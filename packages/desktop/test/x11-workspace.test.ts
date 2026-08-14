import { describe, expect, it, vi } from 'vitest';
import {
  parseX11Workspace,
  readX11Workspace,
  restoreX11Workspace,
  x11WindowId,
} from '../src/x11-workspace';

describe('X11 workspace persistence', () => {
  it('extracts Electron X11 media ids', () => {
    expect(x11WindowId('window:12345:0')).toBe('12345');
    expect(x11WindowId('screen:0:0')).toBeNull();
  });

  it('parses decimal and hexadecimal EWMH workspace properties', () => {
    expect(parseX11Workspace('_NET_WM_DESKTOP(CARDINAL) = 4\n')).toBe(4);
    expect(parseX11Workspace('_NET_WM_DESKTOP(CARDINAL) = 0x00000002')).toBe(2);
    expect(parseX11Workspace('_NET_WM_DESKTOP:  not found.')).toBeNull();
    expect(parseX11Workspace('_NET_WM_DESKTOP(CARDINAL) = 0xFFFFFFFF')).toBeNull();
  });

  it('reads through xprop without a shell', () => {
    const runner = vi.fn(() => '_NET_WM_DESKTOP(CARDINAL) = 3\n');
    expect(readX11Workspace('window:88:0', runner)).toBe(3);
    expect(runner).toHaveBeenCalledWith(['-id', '88', '_NET_WM_DESKTOP']);
  });

  it('sets the pre-map EWMH hint and degrades on failure', () => {
    const runner = vi.fn(() => '');
    expect(restoreX11Workspace('window:88:0', 3, runner)).toBe(true);
    expect(runner).toHaveBeenCalledWith([
      '-id',
      '88',
      '-f',
      '_NET_WM_DESKTOP',
      '32c',
      '-set',
      '_NET_WM_DESKTOP',
      '3',
    ]);
    expect(
      restoreX11Workspace('window:88:0', 3, () => {
        throw new Error('no display');
      }),
    ).toBe(false);
  });
});
