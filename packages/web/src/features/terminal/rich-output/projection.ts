import type { TerminalRichBlock } from './rich-output-buffer';

export interface Projection {
  blocks: TerminalRichBlock[];
  viewportY: number;
  buffer: string;
  width: number;
  cellWidth: number;
  cellHeight: number;
  fontSize: number;
}

/** Preserve React state identity when a scan finds the same content and geometry. */
export function sameProjection(previous: Projection | null, next: Projection): boolean {
  return (
    previous !== null &&
    previous.viewportY === next.viewportY &&
    previous.buffer === next.buffer &&
    previous.width === next.width &&
    previous.cellWidth === next.cellWidth &&
    previous.cellHeight === next.cellHeight &&
    previous.fontSize === next.fontSize &&
    previous.blocks.length === next.blocks.length &&
    previous.blocks.every((block, index) => {
      const other = next.blocks[index]!;
      return (
        block.kind === other.kind &&
        block.source === other.source &&
        block.display === other.display &&
        block.start.row === other.start.row &&
        block.start.col === other.start.col &&
        block.end.row === other.end.row &&
        block.end.col === other.end.col
      );
    })
  );
}
