import { toast } from 'sonner';

/**
 * Resolving a drop/paste DataTransfer into uploadable Files, folders included.
 *
 * A dropped directory (surfaced via `webkitGetAsEntry`) is walked recursively
 * and every descendant file is re-wrapped as a File whose NAME is its path
 * relative to the drop target (`photos/cats/one.png`) — the multipart filename
 * is how the relative path travels, and the daemon rebuilds the tree from it
 * (protocol ≥ 9.2). Empty directories yield no files and are simply not
 * created host-side. On an older daemon, which would flatten those paths to
 * basenames, folders are rejected with a toast instead — the pre-9.2
 * behaviour (PROTOCOL.md rule 3).
 */

interface CapturedTransferItem {
  entry: FileSystemEntry | null;
  file: File | null;
  mime: string;
}

interface CapturedTransfer {
  items: CapturedTransferItem[];
  fallback: File[];
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
};

function captureTransfer(
  items: DataTransferItemList | undefined,
  files: FileList,
): CapturedTransfer {
  return {
    items: Array.from(items ?? []).map((item) => ({
      entry: item.webkitGetAsEntry?.() ?? null,
      file: item.kind === 'file' ? item.getAsFile() : null,
      mime: item.type,
    })),
    // Some paste flows surface files without item entries — fall back to the list.
    fallback: Array.from(files),
  };
}

function isEmptyCapture(captured: CapturedTransferItem[]): boolean {
  return captured.every(({ entry, file }) => entry === null && file === null);
}

function imageExtension(file: File, mime: string): string {
  const normalisedMime = (file.type || mime).toLowerCase().split(';', 1)[0]!;
  const known = IMAGE_EXTENSIONS[normalisedMime];
  if (known) return known;

  const original = file.name.match(/\.([a-z0-9]{1,10})$/i)?.[1];
  if (original) return original.toLowerCase();

  const subtype = normalisedMime
    .slice('image/'.length)
    .replace(/^x-/, '')
    .split('+', 1)[0]!
    .replace(/[^a-z0-9-]/g, '');
  return subtype || 'image';
}

function screenshotName(pastedAt: Date, file: File, mime: string, index: number): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const date = `${pastedAt.getFullYear()}-${pad(pastedAt.getMonth() + 1)}-${pad(pastedAt.getDate())}`;
  const time = `${pad(pastedAt.getHours())}.${pad(pastedAt.getMinutes())}.${pad(pastedAt.getSeconds())}.${pad(pastedAt.getMilliseconds(), 3)}`;
  const suffix = index === 0 ? '' : ` (${index + 1})`;
  return `Screenshot ${date} at ${time}${suffix}.${imageExtension(file, mime)}`;
}

/** `readEntries` returns at most ~100 entries per call (Chromium); drain until an empty batch. */
async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    // Re-wrapping with a new name references the same bytes — no copy is made.
    out.push(
      prefix
        ? new File([file], `${prefix}/${entry.name}`, {
            type: file.type,
            lastModified: file.lastModified,
          })
        : file,
    );
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry as FileSystemDirectoryEntry);
    const dir = prefix ? `${prefix}/${entry.name}` : entry.name;
    for (const child of children) await walk(child, dir, out);
  }
}

async function resolveCapturedFiles(
  transfer: CapturedTransfer,
  foldersSupported: boolean,
): Promise<File[]> {
  const captured = transfer.items;
  if (isEmptyCapture(captured)) return transfer.fallback;
  if (!foldersSupported) {
    if (captured.some(({ entry }) => entry?.isDirectory)) {
      toast.error("This daemon can't take folders — update it, or zip them first");
    }
    return captured
      .filter(({ entry }) => entry?.isDirectory !== true)
      .map(({ file }) => file)
      .filter((file): file is File => file !== null);
  }
  const out: File[] = [];
  for (const { entry, file } of captured) {
    if (entry?.isDirectory) await walk(entry, '', out);
    else if (file) out.push(file);
  }
  return out;
}

/**
 * MUST be called synchronously from the drop/paste event handler — a
 * DataTransfer's items are only readable while the event dispatches, so the
 * entries are captured in the synchronous prologue, before the first await.
 */
export function collectDroppedFiles(
  items: DataTransferItemList | undefined,
  files: FileList,
  foldersSupported: boolean,
): Promise<File[]> {
  return resolveCapturedFiles(captureTransfer(items, files), foldersSupported);
}

/** Whether a clipboard dispatch exposes files that should win over the internal tree clipboard. */
export function hasPastedFiles(items: DataTransferItemList | undefined, files: FileList): boolean {
  return files.length > 0 || Array.from(items ?? []).some((item) => item.kind === 'file');
}

/**
 * Resolve clipboard files like a drop, but give clipboard images a useful,
 * collision-resistant screenshot name based on the local time of the paste.
 * Non-image files retain their real name.
 */
export function collectPastedFiles(
  items: DataTransferItemList | undefined,
  files: FileList,
  foldersSupported: boolean,
  pastedAt = new Date(),
): Promise<File[]> {
  const transfer = captureTransfer(items, files);
  const usedFallback = isEmptyCapture(transfer.items);
  const pastedImages = new Map<File, string>();
  for (const { file, mime } of transfer.items) {
    const effectiveMime = file?.type || mime;
    if (file && effectiveMime.startsWith('image/')) {
      pastedImages.set(file, effectiveMime);
    }
  }
  if (usedFallback) {
    for (const file of transfer.fallback) {
      if (file.type.startsWith('image/')) pastedImages.set(file, file.type);
    }
  }

  return resolveCapturedFiles(transfer, foldersSupported).then((resolved) => {
    let imageIndex = 0;
    return resolved.map((file) => {
      const mime = pastedImages.get(file);
      if (!mime) return file;
      const renamed = new File([file], screenshotName(pastedAt, file, mime, imageIndex), {
        type: file.type || mime,
        lastModified: file.lastModified,
      });
      imageIndex += 1;
      return renamed;
    });
  });
}
