import { useSyncExternalStore } from 'react';
import { clientSettings, useClientSettings } from '../settings/client-settings';

const query = '(prefers-reduced-motion: reduce)';
const systemReducedMotion = () => matchMedia(query).matches;
const subscribe = (notify: () => void) => {
  const media = matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};

export function reducedMotion(): boolean {
  return clientSettings().reduceMotion || systemReducedMotion();
}

export function useReducedMotion(): boolean {
  const settings = useClientSettings();
  const system = useSyncExternalStore(subscribe, systemReducedMotion);
  return settings.reduceMotion || system;
}
