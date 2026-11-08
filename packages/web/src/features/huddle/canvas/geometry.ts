export interface Position {
  x: number;
  y: number;
}
export const NODE_WIDTH = 240;
export function defaultPosition(index: number): Position {
  return { x: (index % 3) * 320, y: Math.floor(index / 3) * 220 };
}
export function movePosition(origin: Position, dx: number, dy: number): Position {
  const bound = (value: number) => Math.min(1_000_000, Math.max(-1_000_000, Math.round(value)));
  return { x: bound(origin.x + dx), y: bound(origin.y + dy) };
}
