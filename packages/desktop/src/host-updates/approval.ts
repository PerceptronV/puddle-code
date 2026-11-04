import { dialog, type BrowserWindow } from 'electron';
import {
  daemonUpgradeMessage,
  hostUpdateInterruptionMessage,
  type ConfirmDaemonUpgrade,
  type ConfirmHostUpdateInterruption,
} from '@puddle-code/cli/lib';

/** Shell presentation only; the shared coordinator owns exact consent and authority checks. */
export function hostUpdateApprovals(options: {
  host: string;
  parent: () => BrowserWindow | undefined;
  active: () => boolean;
}): {
  confirmDaemonUpgrade: ConfirmDaemonUpgrade;
  confirmInterruption: ConfirmHostUpdateInterruption;
} {
  const ask = async (message: string, detail: string, action: string) => {
    if (!options.active()) return false;
    const parent = options.parent();
    const request = {
      type: 'question' as const,
      title: 'Update host daemon',
      message,
      detail,
      buttons: [action, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const result = await (parent && !parent.isDestroyed()
      ? dialog.showMessageBox(parent, request)
      : dialog.showMessageBox(request));
    return options.active() && (!parent || !parent.isDestroyed()) && result.response === 0;
  };
  return {
    confirmDaemonUpgrade: (request) =>
      ask(`Update Puddle on ${request.host}?`, daemonUpgradeMessage(request), 'Update and connect'),
    confirmInterruption: (request) =>
      ask(
        `Interrupt the reviewed work on ${options.host}?`,
        hostUpdateInterruptionMessage(options.host, request),
        'Interrupt and update',
      ),
  };
}
