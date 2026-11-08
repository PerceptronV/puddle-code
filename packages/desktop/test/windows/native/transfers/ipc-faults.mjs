/** Test-only interception around the real registered IPC handlers. */
export function installTransferFaults(ipcMain) {
  const allowed = new Set([
    'puddle:window-prepare-pane',
    ...['accept', 'commit', 'observe', 'cancel'].map((name) => `puddle:window-transfer-${name}`),
  ]);
  const handle = ipcMain.handle.bind(ipcMain);
  let armed = null;
  let held = null;
  let reached = null;
  let calls = [];
  const boundary = async (phase, channel, event, value) => {
    if (armed?.phase !== phase || armed.channel !== channel) return;
    const fault = armed;
    armed = null;
    reached = { phase, channel, id: value.id, sender: event.sender.id };
    if (fault.action === 'reject') throw new Error('Injected lost native transfer reply');
    await new Promise((resolve) => {
      held = resolve;
    });
  };
  ipcMain.handle = (channel, handler) =>
    handle(
      channel,
      allowed.has(channel)
        ? async (event, value) => {
            calls.push({ channel, id: value.id });
            await boundary('before', channel, event, value);
            const result = await handler(event, value);
            await boundary('after', channel, event, value);
            return result;
          }
        : handler,
    );
  globalThis.nativeTransferFaults = {
    arm(fault) {
      if (armed || held) throw new Error('A transfer fault is already armed');
      if (
        !allowed.has(fault.channel) ||
        !['before', 'after'].includes(fault.phase) ||
        !['hold', 'reject'].includes(fault.action)
      )
        throw new Error('Invalid transfer fault');
      calls = [];
      reached = null;
      armed = fault;
    },
    snapshot: () => ({ reached, calls }),
    release() {
      const resolve = held;
      held = null;
      resolve?.();
    },
  };
}
