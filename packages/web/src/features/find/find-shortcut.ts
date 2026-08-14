const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Monaco's find entry point: Command+F on Apple platforms, Ctrl+F elsewhere. */
export function isFindShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  isMac = IS_MAC,
): boolean {
  return (
    event.key.toLowerCase() === 'f' &&
    !event.altKey &&
    !event.shiftKey &&
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}
