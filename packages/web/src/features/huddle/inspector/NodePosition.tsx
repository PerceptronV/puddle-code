import { useId, useState } from 'react';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import type { Position } from '../canvas/geometry';
import { graphActionClass } from './GraphEditing';

export function NodePosition({
  position,
  locked,
  apply,
}: {
  position: Position;
  locked: boolean;
  apply(position: Position): void;
}) {
  const id = useId();
  const [x, setX] = useState(String(position.x)),
    [y, setY] = useState(String(position.y));
  const valid = [x, y].every(
    (value) =>
      value.trim() !== '' && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 1_000_000,
  );
  return (
    <fieldset className="my-4 flex flex-col gap-2" disabled={locked}>
      <legend className="mb-2 text-xs text-fg-muted">Position</legend>
      <Label htmlFor={`${id}-x`}>X</Label>
      <Input
        id={`${id}-x`}
        type="number"
        value={x}
        onChange={(event) => setX(event.target.value)}
      />
      <Label htmlFor={`${id}-y`}>Y</Label>
      <Input
        id={`${id}-y`}
        type="number"
        value={y}
        onChange={(event) => setY(event.target.value)}
      />
      <button
        type="button"
        className={graphActionClass}
        disabled={!valid}
        onClick={() => apply({ x: Number(x), y: Number(y) })}
      >
        Apply position
      </button>
      <p className="text-xs text-fg-muted">
        Drag a node or use its arrow keys. Shift moves farther.
      </p>
    </fieldset>
  );
}
