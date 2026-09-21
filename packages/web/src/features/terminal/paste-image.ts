import { toast } from 'sonner';
import { HOME_STREAM, pasteImageResponseSchema } from '@puddle/shared';
import { api } from '../../lib/api';
import { browserTransport } from '../../lib/browser-transport';
import { wsManager } from '../../lib/ws';
import { prepareImage } from './prepare-image';

/**
 * Clipboard-image paste for terminals (SPEC §7). xterm's built-in paste only
 * reads text/plain, so an image on the clipboard would silently vanish — and
 * the agent's own Ctrl+V clipboard read happens on the daemon's machine, which
 * in SSH mode is not where the image lives. Instead: upload the bytes to the
 * daemon (`POST /api/worktrees/:sid/paste`), which writes them into the
 * session worktree's `.puddle/pastes/`, then insert the returned path into the
 * terminal's stdin, unsubmitted, for the agent to read.
 *
 * Returns true when the paste was intercepted (caller must preventDefault).
 * Mixed clipboards (text + image, e.g. copied rich text) stay on xterm's
 * normal text path, so only pure image pastes — screenshots, copied images —
 * are taken over.
 */
export function interceptImagePaste(e: ClipboardEvent, stream: string, term: string): boolean {
  // Login/home PTYs have no worktree to upload into.
  if (stream.startsWith('login-') || stream === HOME_STREAM) return false;
  const items = Array.from(e.clipboardData?.items ?? []);
  if (items.some((item) => item.type === 'text/plain')) return false;
  const image = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
  if (!image) return false;
  const file = image.getAsFile(); // must be read synchronously, before the event is recycled
  if (!file) return false;

  void pasteImage(file, stream, term)
    .then(({ resized }) => {
      if (resized) toast('Image resized for remote access');
    })
    .catch((err: unknown) => {
      toast.error(
        err instanceof Error ? `Image paste failed: ${err.message}` : 'Image paste failed',
      );
    });
  return true;
}

/** Shared by desktop clipboard paste and the mobile image picker; never submits. */
export async function pasteImage(
  file: File,
  stream: string,
  term: string,
): Promise<{ resized: boolean }> {
  if (stream.startsWith('login-') || stream === HOME_STREAM)
    throw new Error('Open a project terminal to attach an image.');
  const transport = browserTransport();
  const checkConnection = () => {
    if (browserTransport() !== transport || !wsManager.isConnected())
      throw new Error('The terminal connection changed; the image was not inserted.');
  };
  checkConnection();
  const { blob, mime, resized } = await prepareImage(file, transport !== null);
  const data = await toBase64(blob);
  checkConnection();
  const res = pasteImageResponseSchema.parse(
    await api('POST', `/api/worktrees/${stream}/paste`, { mime, data }),
  );
  checkConnection();
  if (transport) await transport.input(stream, term, `${res.path} `);
  else wsManager.write(stream, term, `${res.path} `);
  return { resized };
}

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the clipboard image'));
    reader.readAsDataURL(file);
  });
}
