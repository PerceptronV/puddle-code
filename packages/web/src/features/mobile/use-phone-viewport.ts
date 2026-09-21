import { useEffect } from 'react';

export function usePhoneViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      document.documentElement.style.setProperty(
        '--phone-height',
        `${viewport?.height ?? window.innerHeight}px`,
      );
      document.documentElement.style.setProperty('--phone-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--phone-height');
      document.documentElement.style.removeProperty('--phone-top');
    };
  }, []);
}
