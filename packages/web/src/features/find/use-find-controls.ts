import { useCallback, useEffect, useRef, useState } from 'react';
import { isFindShortcut } from './find-shortcut';
import {
  DEFAULT_FIND_OPTIONS,
  EMPTY_FIND_RESULT,
  type FindDirection,
  type FindOptions,
  type FindResult,
} from './find-types';

export interface FindControls {
  open: boolean;
  focusKey: number;
  query: string;
  options: FindOptions;
  result: FindResult;
  openFind: () => void;
  close: () => void;
  next: () => void;
  previous: () => void;
  refresh: () => void;
  setQuery: (query: string) => void;
  setOptions: (options: FindOptions) => void;
  setResult: (result: FindResult) => void;
}

/** State and keyboard behaviour shared by each view-specific search adapter. */
export function useFindControls({
  shortcutEnabled,
  onFind,
  onClear,
  onCloseFocus,
}: {
  shortcutEnabled: boolean;
  onFind: (query: string, options: FindOptions, direction: FindDirection) => FindResult | void;
  onClear: () => void;
  onCloseFocus?: () => void;
}): FindControls {
  const [open, setOpen] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState(DEFAULT_FIND_OPTIONS);
  const [result, setResult] = useState<FindResult>(EMPTY_FIND_RESULT);
  const stateRef = useRef({ open, query, options });
  stateRef.current = { open, query, options };
  const findRef = useRef(onFind);
  findRef.current = onFind;
  const clearRef = useRef(onClear);
  clearRef.current = onClear;
  const closeFocusRef = useRef(onCloseFocus);
  closeFocusRef.current = onCloseFocus;

  const run = useCallback((direction: FindDirection) => {
    const state = stateRef.current;
    if (!state.open) return;
    const nextResult = findRef.current(state.query, state.options, direction);
    if (nextResult) setResult(nextResult);
  }, []);

  const openFind = useCallback(() => {
    setOpen(true);
    setFocusKey((value) => value + 1);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    clearRef.current();
    closeFocusRef.current?.();
  }, []);
  const next = useCallback(() => run('next'), [run]);
  const previous = useCallback(() => run('previous'), [run]);
  const refresh = useCallback(() => run('reset'), [run]);

  useEffect(() => {
    if (!open) return;
    run('reset');
  }, [open, query, options, run]);

  useEffect(() => {
    if (!shortcutEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      openFind();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcutEnabled, openFind]);

  useEffect(
    () => () => {
      clearRef.current();
    },
    [],
  );

  return {
    open,
    focusKey,
    query,
    options,
    result,
    openFind,
    close,
    next,
    previous,
    refresh,
    setQuery,
    setOptions,
    setResult,
  };
}
