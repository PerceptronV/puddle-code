import { useEffect, useState } from 'react';

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
  // Window full-screen state (optional: absent on shells older than the
  // feature). macOS hides the inlaid traffic lights in full-screen, so the top
  // bar must drop the inset it keeps for them.
  /** Whether this window is full-screen right now. */
  isFullScreen?(): Promise<boolean>;
  /** Fires on enter/leave full-screen; returns the unsubscribe. */
  onFullScreenChange?(callback: (full: boolean) => void): () => void;
}

declare global {
  interface Window {
    puddleDesktop?: PuddleDesktopBridge;
  }
}

export function desktopBridge(): PuddleDesktopBridge | undefined {
  return window.puddleDesktop;
}

/**
 * Whether the desktop window is full-screen (always false in a browser, and on
 * a shell too old to report it — which keeps the pre-feature behaviour). Asks
 * once on mount, since a reload while full-screen fires no transition event.
 *
 * `animate` distinguishes the two ways the answer arrives: the mount-time query
 * is simply the truth about a window that was ALREADY full-screen and must land
 * with no motion, while an enter/leave event is a transition the user just made
 * and the top bar slides for (`TopBar`). Both are one state object so the pair
 * can never be committed apart — a separate flag flipping in the same commit as
 * the initial value would animate the very case it exists to suppress.
 */
export function useDesktopFullScreen(): { fullScreen: boolean; animate: boolean } {
  const [state, setState] = useState({ fullScreen: false, animate: false });
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let live = true;
    void bridge.isFullScreen?.()?.then((v) => {
      if (live) setState({ fullScreen: v, animate: false });
    });
    const off = bridge.onFullScreenChange?.((v) => setState({ fullScreen: v, animate: true }));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return state;
}
