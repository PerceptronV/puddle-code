import { toast } from 'sonner';
import { pasteImageMimeSchema, type PasteImageMime, type PasteImageResponse } from '@puddle/shared';
import { api } from '../../lib/api';
import { wsManager } from '../../lib/ws';

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
  if (stream.startsWith('login-')) return false; // login PTYs have no worktree
  const items = Array.from(e.clipboardData?.items ?? []);
  if (items.some((item) => item.type === 'text/plain')) return false;
  const image = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
  if (!image) return false;
  const file = image.getAsFile(); // must be read synchronously, before the event is recycled
  if (!file) return false;

  const mime = pasteImageMimeSchema.safeParse(image.type);
  if (!mime.success) {
    toast.error(`Cannot paste ${image.type} — png, jpeg, gif, and webp are supported`);
    return true;
  }
  void upload(file, mime.data, stream, term);
  return true;
}

async function upload(
  file: File,
  mime: PasteImageMime,
  stream: string,
  term: string,
): Promise<void> {
  try {
    const data = await toBase64(file);
    const res = await api<PasteImageResponse>('POST', `/api/worktrees/${stream}/paste`, {
      mime,
      data,
    });
    wsManager.write(stream, term, `${res.path} `);
  } catch (err) {
    toast.error(err instanceof Error ? `Image paste failed: ${err.message}` : 'Image paste failed');
  }
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the clipboard image'));
    reader.readAsDataURL(file);
  });
}
