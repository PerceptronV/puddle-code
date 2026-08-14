import { useEffect, useRef } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { FindOptions, FindResult } from './find-types';
import { isFindShortcut } from './find-shortcut';

function Toggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        'rounded-sm p-1 transition-colors',
        active ? 'bg-surface text-accent' : 'text-fg-muted hover:bg-surface hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function ResultLabel({ query, result }: { query: string; result: FindResult }) {
  if (query.length === 0) return null;
  if (result.invalid) return <>Invalid expression</>;
  if (result.count === 0) return <>No results</>;
  if (result.limited) return <>{result.count}+ results</>;
  if (result.index < 0) return <>{result.count} results</>;
  return (
    <>
      {result.index + 1} of {result.count}
    </>
  );
}

/** A compact, borderless find control shared by rendered files and xterm. */
export function FindWidget({
  query,
  focusKey,
  options,
  result,
  onQueryChange,
  onOptionsChange,
  onNext,
  onPrevious,
  onClose,
}: {
  query: string;
  focusKey: number;
  options: FindOptions;
  result: FindResult;
  onQueryChange: (query: string) => void;
  onOptionsChange: (options: FindOptions) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  const canNavigate = result.count > 0 && !result.invalid;
  return (
    <div
      role="search"
      aria-label="Find in view"
      className="absolute right-2 top-0 z-30 flex h-10 w-[min(34rem,calc(100%-0.5rem))] items-center gap-1.5 rounded-b-md bg-surface px-1.5 shadow-lg"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) onPrevious();
          else onNext();
          return;
        }
        if (isFindShortcut(event.nativeEvent)) {
          event.preventDefault();
          event.stopPropagation();
          inputRef.current?.select();
        }
      }}
    >
      <div className="flex min-w-0 flex-1 items-center rounded-md bg-elevated pl-2 pr-0.5">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Find"
          spellCheck={false}
          autoComplete="off"
          aria-label="Find"
          className="h-7 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
        />
        <Toggle
          active={options.caseSensitive}
          label="Match case"
          onClick={() => onOptionsChange({ ...options, caseSensitive: !options.caseSensitive })}
        >
          <CaseSensitive className="size-3.5" />
        </Toggle>
        <Toggle
          active={options.wholeWord}
          label="Match whole word"
          onClick={() => onOptionsChange({ ...options, wholeWord: !options.wholeWord })}
        >
          <WholeWord className="size-3.5" />
        </Toggle>
        <Toggle
          active={options.regex}
          label="Use regular expression"
          onClick={() => onOptionsChange({ ...options, regex: !options.regex })}
        >
          <Regex className="size-3.5" />
        </Toggle>
      </div>
      <div className="w-20 shrink-0 text-center text-xs text-fg-muted">
        <ResultLabel query={query} result={result} />
      </div>
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!canNavigate}
        onClick={onPrevious}
        className="rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg disabled:cursor-default disabled:opacity-40"
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!canNavigate}
        onClick={onNext}
        className="rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg disabled:cursor-default disabled:opacity-40"
      >
        <ChevronDown className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Close find"
        title="Close (Escape)"
        onClick={onClose}
        className="rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
