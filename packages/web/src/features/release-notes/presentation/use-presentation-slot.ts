import { useLayoutEffect, useState } from 'react';

/** Automatic notes must not compete with a dialog the user is already opening. */
export function usePresentationSlot(): boolean {
  const [available, setAvailable] = useState(false);
  useLayoutEffect(() => {
    const inspect = () => {
      const occupied = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"], dialog[open]',
        ),
      ).some(
        (element) =>
          !element.hasAttribute('data-release-notes') &&
          !element.hidden &&
          element.getAttribute('data-state') !== 'closed',
      );
      setAvailable(!occupied);
    };
    // Only pending notes subscribe. Include portals committed while the lazy
    // preview is loading, and retain the queued notes until the other dialog closes.
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'hidden', 'open', 'role'],
    });
    inspect();
    return () => observer.disconnect();
  }, []);
  return available;
}
