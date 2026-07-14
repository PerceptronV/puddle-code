import { useState } from 'react';
import { cn } from '../../lib/utils';
import { Input } from './input';
import { menuHighlightCmdk, menuRow } from './recipes';

export interface Hint {
  /** What choosing this hint puts into the field. */
  value: string;
  /** Displayed text; defaults to the value. */
  label?: string;
  /** Small muted marker on the right (e.g. "git", "registered"). */
  badge?: string;
}

/**
 * A text input with a hint list underneath: arrow keys/Tab/Enter to choose,
 * Escape closes the list only. The caller owns the value and the hints.
 */
export function HintInput({
  id,
  value,
  onValueChange,
  onChoose,
  hints,
  placeholder,
  className,
  hintsClassName,
  autoFocus,
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  onChoose?: (hint: Hint) => void;
  hints: Hint[];
  placeholder?: string;
  className?: string;
  /** Width/overflow classes for the hint list; defaults to matching the input. */
  hintsClassName?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const choose = (hint: Hint) => {
    onValueChange(hint.value);
    onChoose?.(hint);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || hints.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % hints.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + hints.length) % hints.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const hint = hints[active] ?? hints[0];
      if (hint) {
        e.preventDefault();
        choose(hint);
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // close the hints, not any surrounding dialog
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
      />
      {open && hints.length > 0 && (
        <ul
          className={cn(
            'absolute top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md bg-elevated p-1 shadow-xl',
            hintsClassName ?? 'w-full',
          )}
        >
          {hints.map((hint, index) => (
            <li key={hint.value}>
              <button
                type="button"
                // Fires before the input's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(hint);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(menuRow, menuHighlightCmdk, 'w-full font-mono text-xs')}
                data-selected={index === active}
              >
                <span className="truncate">{hint.label ?? hint.value}</span>
                {hint.badge && (
                  <span className="ml-auto shrink-0 text-2xs opacity-70">{hint.badge}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
