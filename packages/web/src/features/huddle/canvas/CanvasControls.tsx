import { ControlTray } from '../../../components/ui/control-tray';

const action = 'rounded-md px-2 py-1 text-xs hover:bg-elevated disabled:opacity-50';
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
    <div className="flex shrink-0 justify-end px-3 py-2">
      <ControlTray label="Graph navigation" variant="island" className="max-w-full flex-wrap">
        <button type="button" className={action} onClick={undo} disabled={locked || !canUndo}>
          Undo move
        </button>
        <button type="button" className={action} onClick={redo} disabled={locked || !canRedo}>
          Redo move
        </button>
        <button type="button" className={action} onClick={() => fit(false)}>
          Fit graph
        </button>
        <button type="button" className={action} disabled={!selected} onClick={() => fit(true)}>
          Fit selected
        </button>
        <button
          type="button"
          className={action}
          aria-label="Zoom out"
          onClick={() => setZoom(Math.max(0.001, zoom / 1.25))}
        >
          −
        </button>
        <button type="button" className={action} aria-label="Reset zoom" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className={action}
          aria-label="Zoom in"
          onClick={() => setZoom(Math.min(2, zoom * 1.25))}
        >
          +
        </button>
      </ControlTray>
    </div>
  );
}
