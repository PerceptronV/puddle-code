import { useRef, type ComponentProps } from 'react';
import { useHoverSurface } from '../../../components/ui/use-tray-hover';
import { cn } from '../../../lib/utils';
import '../../../components/ui/control-tray.css';

/** One moving surface for all visible session groups within a scrolling island. */
export function SessionHoverList({ children, className, ...props }: ComponentProps<'div'>) {
  const ref = useRef<HTMLDivElement>(null);
  const hover = useHoverSurface(ref, { selector: '[data-session-hover]', direct: false });
  return (
    <div {...props} ref={ref} className={cn('session-hover-list relative isolate', className)}>
      <span ref={hover} aria-hidden className="tray-hover-surface session-hover-surface" />
      {children}
    </div>
  );
}
