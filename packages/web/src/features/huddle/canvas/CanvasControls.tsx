import { Undo2, Redo2, Scan, Focus, Minus, Plus } from 'lucide-react';
import { ControlTray } from '../../../components/ui/control-tray';
import { HuddleAction } from '../controls/HuddleAction';

export function CanvasControls({
  locked,
  canUndo,
  canRedo,
  undo,
  redo,
  selected,
  fit,
  zoom,
  setZoom,
}: {
  locked: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
  selected: string | null;
  fit(selection: boolean): void;
  zoom: number;
  setZoom(zoom: number): void;
}) {
  return (
    <div className="absolute bottom-3 left-3 z-10 max-w-[calc(100%-1.5rem)]">
      <ControlTray label="Graph navigation" variant="island" className="max-w-full flex-wrap">
        <HuddleAction label="Undo move" icon={Undo2} onClick={undo} disabled={locked || !canUndo} />
        <HuddleAction label="Redo move" icon={Redo2} onClick={redo} disabled={locked || !canRedo} />
        <HuddleAction label="Fit graph" icon={Scan} onClick={() => fit(false)} />
        <HuddleAction
          label="Fit selected"
          icon={Focus}
          disabled={!selected}
          onClick={() => fit(true)}
        />
        <HuddleAction
          label="Zoom out"
          icon={Minus}
          onClick={() => setZoom(Math.max(0.001, zoom / 1.25))}
        />
        <button
          type="button"
          className="px-2 text-xs tabular-nums"
          aria-label="Reset zoom"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <HuddleAction
          label="Zoom in"
          icon={Plus}
          onClick={() => setZoom(Math.min(2, zoom * 1.25))}
        />
      </ControlTray>
    </div>
  );
}
