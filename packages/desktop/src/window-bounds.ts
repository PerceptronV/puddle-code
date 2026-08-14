export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const PREFERRED = { width: 1440, height: 900 };

/** Initial cockpit geometry; macOS always meets the work area's bottom edge. */
export function initialCockpitBounds(
  platform: NodeJS.Platform,
  workArea?: DisplayWorkArea,
): WindowBounds {
  if (platform !== 'darwin' || workArea === undefined) return PREFERRED;
  const width = Math.min(PREFERRED.width, workArea.width);
  const height = Math.min(PREFERRED.height, workArea.height);
  return {
    width,
    height,
    // Keep narrower windows horizontally centred, but bottom-align every
    // height. A 900px window on a 903px work area otherwise leaves a visible
    // two-pixel strip after integer centring (floor above, remainder below).
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + workArea.height - height,
  };
}
