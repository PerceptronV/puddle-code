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
  const captured = Array.from(items ?? []).map((item) => ({
    entry: item.webkitGetAsEntry?.() ?? null,
    file: item.kind === 'file' ? item.getAsFile() : null,
  }));
  // Some paste flows surface files without item entries — fall back to the list.
  const fallback = Array.from(files);

  return (async () => {
    if (captured.every(({ entry, file }) => entry === null && file === null)) return fallback;
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
  })();
}
