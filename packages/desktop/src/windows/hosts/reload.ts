import type { WebContents } from 'electron';

/** Keep native navigation serial until the replacement document finishes or fails. */
export function reloadContents(contents: WebContents, ignoreCache = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', loaded);
      contents.removeListener('did-fail-load', failed);
      contents.removeListener('destroyed', destroyed);
      if (error) reject(error);
      else resolve();
    };
    const loaded = () => finish();
    const destroyed = () => finish(new Error('Window closed during reload'));
    const failed = (
      _event: unknown,
      _code: number,
      description: string,
      _url: string,
      mainFrame: boolean,
    ) => {
      if (mainFrame) finish(new Error(`Window could not reload: ${description}`));
    };
    const timer = setTimeout(() => finish(new Error('Window reload timed out')), 30_000);
    contents.once('did-finish-load', loaded);
    contents.on('did-fail-load', failed);
    contents.once('destroyed', destroyed);
    try {
      if (contents.isDestroyed()) return destroyed();
      if (ignoreCache) contents.reloadIgnoringCache();
      else contents.reload();
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Window could not reload'));
    }
  });
}
