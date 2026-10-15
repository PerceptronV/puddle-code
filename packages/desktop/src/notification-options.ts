import type { NotificationConstructorOptions } from 'electron';
import type { DesktopNotificationRequest } from '@puddle/shared';

/** Keep host/project, session and preview in that order on each desktop. */
export function notificationOptions(
  request: DesktopNotificationRequest,
  platform: NodeJS.Platform,
): NotificationConstructorOptions {
  const options = { title: request.title, body: request.body, silent: true };
  if (!request.subtitle) return options;
  if (platform === 'darwin') return { ...options, subtitle: request.subtitle };
  if (platform === 'win32') {
    // Electron's subtitle is macOS-only. Windows supports three native text
    // blocks through ToastGeneric; custom XML must also preserve silence.
    const text = [request.title, request.subtitle, request.body]
      .map((value) => `<text>${xmlText(value)}</text>`)
      .join('');
    return {
      ...options,
      toastXml:
        `<toast><visual><binding template="ToastGeneric">${text}</binding></visual>` +
        '<audio silent="true"/></toast>',
    };
  }
  // The Linux notification protocol has only a summary and a body. Keep
  // the session above the preview; the desktop controls wrapping and styling.
  return { ...options, body: `${request.subtitle}\n${request.body}` };
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
