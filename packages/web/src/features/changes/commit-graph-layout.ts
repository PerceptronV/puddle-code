/**
 * Pure commit-graph lane layout (SPEC §8, Changes navigator). Turns a list of
 * commits (newest first, each with its parent shas) into per-row lane
 * geometry: the node's column, the lanes entering from the row above and
 * leaving to the row below, and which of those below-lanes originate at this
 * node. The renderer (`CommitGraph.tsx`) draws one self-contained SVG cell per
 * row from this, so expandable file lists can slot between commit rows without
 * disturbing the graph. Monaco-free and DOM-free so it is unit-testable.
 *
 * The algorithm is the standard top-to-bottom lane assignment: a lane "expects"
 * a sha; when that commit is reached the lane terminates at its node and the
 * node re-emits a lane per parent (the first parent reuses the node's column,
 * so straight-line history stays in one column). Columns freed by a merge are
 * reused, keeping the graph narrow. Colours are CSS-token `var()` strings, so
 * lanes stay theme-aware and never hard-code a hex (tokens.css is the source).
 */

/** Lane colour cycle — semantic tokens only, six distinct hues (SPEC §12). */
const LANE_COLOURS = [
  'var(--accent)',
  'var(--status-running)',
  'var(--status-waiting)',
  'var(--ansi-magenta)',
  'var(--ansi-cyan)',
  'var(--status-interrupted)',
];

export function laneColour(index: number): string {
  return LANE_COLOURS[index % LANE_COLOURS.length]!;
}

export interface GraphLane {
  col: number;
  /** The sha this lane is routing toward (the next commit expected below). */
  sha: string;
  colour: string;
}

export interface GraphRow {
  sha: string;
  /** The node's column. */
  col: number;
  colour: string;
  /** Lanes entering this row from the gap above (empty for the first row). */
  above: GraphLane[];
  /** Lanes leaving this row into the gap below. */
  below: GraphLane[];
  /** Columns in `below` whose lane originates at this node (its parents). */
  created: number[];
}

export interface CommitGraphLayout {
  rows: GraphRow[];
  /** Widest lane index reached + 1 — the column count the gutter must fit. */
  laneCount: number;
}

interface CommitInput {
  sha: string;
  parents?: string[];
}

export function computeCommitGraph(commits: readonly CommitInput[]): CommitGraphLayout {
  interface Lane {
    sha: string;
    colourIdx: number;
  }
  const lanes: (Lane | null)[] = [];
  let nextColourIdx = 0;
  let laneCount = 0;

  const firstFree = (): number => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  const snapshot = (): GraphLane[] => {
    const out: GraphLane[] = [];
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      if (l) out.push({ col: i, sha: l.sha, colour: laneColour(l.colourIdx) });
    }
    return out;
  };

  const rows: GraphRow[] = [];
  let above: GraphLane[] = [];

  for (const commit of commits) {
    const parents = commit.parents ?? [];

    // Which lanes were routing toward this commit (they terminate here).
    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i]?.sha === commit.sha) incoming.push(i);

    let col: number;
    let colourIdx: number;
    if (incoming.length > 0) {
      col = incoming[0]!;
      colourIdx = lanes[col]!.colourIdx;
    } else {
      col = firstFree();
      colourIdx = nextColourIdx++;
    }
    const colour = laneColour(colourIdx);

    for (const i of incoming) lanes[i] = null;
    while (lanes.length <= col) lanes.push(null);

    const created: number[] = [];
    if (parents.length > 0) {
      // First parent continues the node's own column + colour (linear history
      // stays a single straight lane).
      lanes[col] = { sha: parents[0]!, colourIdx };
      created.push(col);
      for (let k = 1; k < parents.length; k++) {
        const p = parents[k]!;
        // Merge into an existing lane already expecting this parent, else open
        // a fresh column with a fresh colour.
        let at = lanes.findIndex((l) => l?.sha === p);
        if (at === -1) {
          at = firstFree();
          while (lanes.length <= at) lanes.push(null);
          lanes[at] = { sha: p, colourIdx: nextColourIdx++ };
        }
        created.push(at);
      }
    } else {
      // Root commit: its column ends here.
      lanes[col] = null;
    }

    const below = snapshot();
    rows.push({ sha: commit.sha, col, colour, above, below, created });
    above = below;
    laneCount = Math.max(laneCount, lanes.length);
  }

  return { rows, laneCount };
}
