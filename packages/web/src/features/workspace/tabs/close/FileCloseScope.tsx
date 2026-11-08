import { createContext, useContext, type ReactNode } from 'react';
import type { UiStateHandle } from '../../use-ui-state';
import { fileViewCount } from './file-views';

const Context = createContext<UiStateHandle | null>(null);

/** Use this renderer's complete working set, including parked project tabs. */
export function FileCloseScope({ state, children }: { state: UiStateHandle; children: ReactNode }) {
  return <Context value={state}>{children}</Context>;
}

export function useRetainFileOnClose(file: Parameters<typeof fileViewCount>[1]) {
  const state = useContext(Context);
  // Read at the gesture and again at approval: another view can open during review.
  return () => state !== null && fileViewCount(state.current(), file) > 1;
}
