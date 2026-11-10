interface HostPrompt {
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  close(): void;
}

/** Native prompt closure can restore the previously focused window. Raise the
 * destination only after that closure, including when reusing an existing host. */
export async function openHostFromPrompt<Window>(options: {
  prompt: HostPrompt | null;
  open(): Promise<Window | undefined>;
  remember(): void;
  raise(window: Window): void;
}): Promise<void> {
  const window = await options.open();
  if (!window) throw new Error('The host connection did not open a window; try connecting again');
  options.remember();
  const prompt = options.prompt;
  if (prompt && !prompt.isDestroyed()) {
    await new Promise<void>((resolve) => {
      prompt.once('closed', resolve);
      prompt.close();
    });
  }
  options.raise(window);
}
