import { useRef } from 'react';
import { Separator } from 'react-resizable-panels';
import { IslandResizeEdges } from '../../../components/ui/island-resize-edges';

/** Highlight only the surfaces touching this divider, including nested panes. */
export function IslandSeparator({ className }: { className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <Separator elementRef={ref} className={className} />
      <IslandResizeEdges separatorRef={ref} vertical={className === 'workspace-divider-vertical'} />
    </>
  );
}
