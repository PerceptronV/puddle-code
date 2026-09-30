import type { GraphLane, GraphRow } from './commit-graph-layout';

/** Gutter geometry (px). One column per lane; the node is vertically centred. */
export const LANE_W = 14;
const NODE_R = 4;
const STROKE = 1.5;
export const COMMIT_ROW_H = 40;
export const FILE_ROW_H = 22;

/** Column centre x for a lane index. */
function laneX(col: number): number {
  return col * LANE_W + LANE_W / 2;
}

/** A smooth vertical-ish connector between two columns across a cell. */
function connector(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/** The self-contained graph cell for one commit row: through-lanes, the merge
 *  connectors into the node, the parent connectors out of it, and the node. */
export function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const h = COMMIT_ROW_H;
  const mid = h / 2;
  const nodeX = laneX(row.col);
  const created = new Set(row.created);
  const paths: { d: string; colour: string }[] = [];

  for (const lane of row.above) {
    const x = laneX(lane.col);
    if (lane.sha === row.sha) paths.push({ d: connector(x, 0, nodeX, mid), colour: lane.colour });
    // Through-lanes remain continuous even when this node also joins them.
    else paths.push({ d: connector(x, 0, x, h), colour: lane.colour });
  }
  for (const lane of row.below) {
    const x = laneX(lane.col);
    if (created.has(lane.col)) paths.push({ d: connector(nodeX, mid, x, h), colour: lane.colour });
  }

  return (
    <svg width={width} height={h} className="shrink-0" aria-hidden>
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill="none" stroke={p.colour} strokeWidth={STROKE} />
      ))}
      <circle
        cx={nodeX}
        cy={mid}
        r={NODE_R}
        fill="var(--bg-surface)"
        stroke={row.colour}
        strokeWidth={STROKE}
      />
    </svg>
  );
}

/** Continuation gutter for an expanded file row: the commit's lanes carry
 *  straight through so the graph stays unbroken past the inline file list. */
export function ContinuationCell({ lanes, width }: { lanes: GraphLane[]; width: number }) {
  return (
    <svg width={width} height={FILE_ROW_H} className="shrink-0" aria-hidden>
      {lanes.map((lane) => {
        const x = laneX(lane.col);
        return (
          <path
            key={lane.col}
            d={`M ${x} 0 L ${x} ${FILE_ROW_H}`}
            fill="none"
            stroke={lane.colour}
            strokeWidth={STROKE}
          />
        );
      })}
    </svg>
  );
}
