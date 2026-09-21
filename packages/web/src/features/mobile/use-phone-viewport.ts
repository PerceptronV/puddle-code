import { useEffect } from 'react';

export function usePhoneViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () =>
      document.documentElement.style.setProperty(
        '--phone-height',
        `${viewport?.height ?? window.innerHeight}px`,
      );
    update();
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--phone-height');
    };
  }, []);
}
