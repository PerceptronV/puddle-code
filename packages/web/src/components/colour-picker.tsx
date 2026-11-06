import { useEffect, useRef } from 'react';
import { Pipette } from 'lucide-react';
import { PROFILE_ICON_COLOURS } from '@puddle/shared';
import { appearanceColourClass, isCustomColour } from '../lib/appearance/appearance-colours';
import { cn } from '../lib/utils';

/** The same compact, theme-aware swatches for profile icons and project names. */
export function ColourPicker({
  value,
  onChange,
  disabled = false,
  label = 'Colour',
  onCustomChange,
}: {
  value: string | null | undefined;
  onChange: (colour: (typeof PROFILE_ICON_COLOURS)[number] | null) => void;
  disabled?: boolean;
  label?: string;
  onCustomChange?: (colour: string) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const picker = input.current;
    if (!picker) return;
    // Native change fires when the selection is committed; React's onChange also
    // fires for every live input event while dragging the system picker.
    const commit = () => {
      if (!disabled && isCustomColour(picker.value)) onCustomChange?.(picker.value);
    };
    picker.addEventListener('change', commit);
    return () => picker.removeEventListener('change', commit);
  }, [disabled, onCustomChange]);
  const openCustom = () => {
    const picker = input.current;
    if (!picker || disabled) return;
    if (isCustomColour(value)) picker.value = value;
    else {
      const swatch =
        group.current!.querySelector<HTMLElement>('[aria-pressed="true"] > span') ??
        group.current!.querySelector<HTMLElement>('button > span')!;
      // Canvas resolves the current CSS colour to the six-digit sRGB form
      // accepted by the native picker, including themes using non-hex colours.
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = getComputedStyle(swatch).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      picker.value =
        '#' +
        [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
    }
    picker.click();
  };
  return (
    <div ref={group} role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      {[null, ...PROFILE_ICON_COLOURS].map((colour) => (
        <button
          key={colour ?? 'default'}
          type="button"
          title={colour ?? 'Default'}
          aria-label={colour ?? 'Default colour'}
          aria-pressed={(value ?? null) === colour}
          disabled={disabled}
          onClick={() => onChange(colour)}
          className={cn(
            'flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-border/50 focus-visible:bg-border/50 disabled:cursor-default disabled:opacity-50',
            (value ?? null) === colour && 'bg-border/50',
          )}
        >
          <span
            className={cn(
              'size-3.5 rounded-full',
              colour
                ? cn('bg-current', appearanceColourClass(colour))
                : 'bg-[var(--identity-default)]',
            )}
          />
        </button>
      ))}
      {onCustomChange && (
        <>
          <button
            type="button"
            title="Custom colour"
            aria-label={`Custom ${label.toLowerCase()}`}
            aria-pressed={isCustomColour(value)}
            disabled={disabled}
            onClick={openCustom}
            className={cn(
              'flex size-7 cursor-pointer items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-border/50 focus-visible:bg-border/50 disabled:cursor-default disabled:opacity-50',
              isCustomColour(value) && 'bg-border/50',
            )}
          >
            {isCustomColour(value) ? (
              <span className="size-3.5 rounded-full" style={{ backgroundColor: value }} />
            ) : (
              <Pipette className="size-3.5" />
            )}
          </button>
          <input
            ref={input}
            type="color"
            aria-label={`${label} custom colour picker`}
            disabled={disabled}
            tabIndex={-1}
            className="sr-only"
          />
        </>
      )}
    </div>
  );
}
