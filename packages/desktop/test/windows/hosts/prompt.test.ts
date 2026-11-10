import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { openHostFromPrompt } from '../../../src/windows/hosts/prompt.js';

function fixture() {
  const prompt = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
  });
  const destination = { id: 'host' };
  const options = {
    prompt,
    open: vi.fn(async () => destination as typeof destination | undefined),
    remember: vi.fn(),
    raise: vi.fn(),
  };
  return { ...options, options, destination };
}

it('raises the destination after native prompt closure has restored the previous focus', async () => {
  const f = fixture();
  const opening = openHostFromPrompt(f.options);
  await vi.waitFor(() => expect(f.prompt.close).toHaveBeenCalledOnce());
  expect(f.remember).toHaveBeenCalledOnce();
  expect(f.raise).not.toHaveBeenCalled();
  f.prompt.emit('closed');
  await opening;
  expect(f.raise).toHaveBeenCalledExactlyOnceWith(f.destination);
});

it('keeps the prompt available when opening a host fails', async () => {
  const f = fixture();
  f.open.mockRejectedValueOnce(new Error('Update requires inspection'));
  await expect(openHostFromPrompt(f.options)).rejects.toThrow('Update requires inspection');
  expect(f.prompt.close).not.toHaveBeenCalled();
  expect(f.remember).not.toHaveBeenCalled();
  expect(f.raise).not.toHaveBeenCalled();
});

it('does not treat a connection returning no window as success', async () => {
  const f = fixture();
  f.open.mockResolvedValueOnce(undefined);
  await expect(openHostFromPrompt(f.options)).rejects.toThrow('did not open a window');
  expect(f.prompt.close).not.toHaveBeenCalled();
  expect(f.raise).not.toHaveBeenCalled();
});

it('raises an opened host even if the user already closed the prompt', async () => {
  const f = fixture();
  f.prompt.isDestroyed.mockReturnValue(true);
  await openHostFromPrompt(f.options);
  expect(f.prompt.close).not.toHaveBeenCalled();
  expect(f.raise).toHaveBeenCalledExactlyOnceWith(f.destination);
});
