/**
 * The desktop shell's preload bridge (packages/desktop/src/preload.ts). Its
 * presence IS the "running inside the desktop app" signal; everything else
 * about the app is identical to the browser cockpit (same origin, same
 * protocol), so this surface must stay tiny — a capability the renderer
 * genuinely cannot provide for itself, or it doesn't belong here.
 */
interface PuddleDesktopBridge {
  /** Bring the app window to the front — renderer window.focus() cannot. */
  raiseWindow(): void;
  /**
   * Close this window (optional: absent on shells older than the feature).
   * A renderer's `window.close()` is ignored for a window it did not open, so
   * only the main process can honour the `window.close` hotkey.
   */
  closeWindow?(): void;
  // Self-update (optional: absent on shells older than the feature). The
  // shell polls GitHub releases and stages updates itself; the renderer only
  // learns a version is ready and asks for the restart (UpdateBanner).
  /** The staged update's version, or null when current. */
  updateReady?(): Promise<string | null>;
  /** Fires when a poll stages an update; returns the unsubscribe. */
  onUpdateReady?(callback: (version: string) => void): () => void;
  /** Quit, swap the install, relaunch. */
  installUpdate?(): void;
}

declare global {
  interface Window {
    puddleDesktop?: PuddleDesktopBridge;
  }
}

export function desktopBridge(): PuddleDesktopBridge | undefined {
  return window.puddleDesktop;
}
