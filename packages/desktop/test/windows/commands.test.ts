import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopWindowCommand } from '@puddle/shared';
import { WindowCommands } from '../../src/windows/commands.js';

afterEach(() => vi.useRealTimers());

it('accepts only the exact registered window reply and ignores late duplicates', async () => {
  const commands = new WindowCommands();
  const send = vi.fn<(command: DesktopWindowCommand) => void>();
  commands.ready('source', send);
  const pending = commands.request('source', 'checkpoint');
  const command = send.mock.calls[0]![0];
  expect(() => commands.reply('sibling', { id: command.id })).toThrow('does not match');
  commands.reply('source', { id: command.id });
  await pending;
  expect(() => commands.reply('source', { id: command.id })).not.toThrow();
});

it('bounds a missing acknowledgement without resending the command', async () => {
  vi.useFakeTimers();
  const commands = new WindowCommands(50);
  const send = vi.fn();
  commands.ready('source', send);
  const pending = expect(commands.request('source', 'checkpoint')).rejects.toThrow('left open');
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  expect(send).toHaveBeenCalledOnce();
});

it('rejects outstanding commands when the renderer reloads and permits its replacement', async () => {
  const commands = new WindowCommands();
  commands.ready('source', vi.fn());
  const pending = expect(commands.request('source', 'checkpoint')).rejects.toThrow('disconnected');
  commands.disconnected('source');
  await pending;
  expect(commands.available('source')).toBe(false);
  const send = vi.fn();
  commands.ready('source', send);
  const resumed = commands.request('source', 'resume');
  commands.reply('source', { id: send.mock.calls[0]![0].id });
  await resumed;
});
