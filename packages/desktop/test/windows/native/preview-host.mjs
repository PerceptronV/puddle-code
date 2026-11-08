// The native acceptance app bundles this in place of the entire CLI library.
// No real launcher, installer, transport, host files or daemon enter that bundle.
import assert from 'node:assert/strict';

export class CliError extends Error {}
export function clientHome() {
  assert.ok(process.env.PUDDLE_NATIVE_TEST_HOME);
  return process.env.PUDDLE_NATIVE_TEST_HOME;
}
export async function startLocal() {
  const origin = new URL(process.env.PREVIEW_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname));
  const counts = (globalThis.nativePreviewConnections ??= { starts: 0, closes: 0 });
  counts.starts++;
  let closed = false;
  return {
    origin: origin.origin,
    createInvitation: () => origin.href,
    close: async () => {
      if (!closed) counts.closes++;
      closed = true;
    },
  };
}
const forbidden = () => {
  throw new Error('Host and installation operations are excluded from native UI acceptance');
};
export const connectRemote = forbidden;
export const applyDesktopUpdate = forbidden;
export const stageDesktopUpdate = forbidden;
export const recordDesktopInstallation = forbidden;
export const daemonUpgradeMessage = forbidden;
export const hostUpdateInterruptionMessage = forbidden;
export const checkForDesktopUpdate = async () => null;
export const pruneDesktopUpdateCache = async () => {};
