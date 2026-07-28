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
}

declare global {
  interface Window {
    puddleDesktop?: PuddleDesktopBridge;
  }
}

export function desktopBridge(): PuddleDesktopBridge | undefined {
  return window.puddleDesktop;
}
