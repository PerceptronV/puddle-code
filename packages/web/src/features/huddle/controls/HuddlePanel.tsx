import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { overlayMotion, overlaySurface } from '../../../components/ui/recipes';
import { HuddleAction } from './HuddleAction';

export const nestedIsland = 'island-outline rounded-[var(--ui-surface-radius)] bg-surface p-3';

export function HuddlePanel({
  title,
  label = title,
  onClose,
  children,
}: {
  title: string;
  label?: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label={label}
      data-state="open"
      className={`${overlaySurface} ${overlayMotion} absolute right-3 top-[var(--huddle-toolbar-bottom,4rem)] bottom-16 z-20 flex w-80 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden text-sm`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <h2 className="min-w-0 truncate">{title}</h2>
        <HuddleAction label={`Close ${label.toLowerCase()}`} icon={X} onClick={onClose} />
      </div>
      <div className="no-scrollbar min-h-0 overflow-y-auto overscroll-contain px-3 pb-3">
        {children}
      </div>
    </aside>
  );
}
