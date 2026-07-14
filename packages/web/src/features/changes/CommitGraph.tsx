import { useMemo, useState } from 'react';
import { useCommitShow, useWorktreeLog } from '../../lib/worktree-queries';
import { cn } from '../../lib/utils';
import { diffStatusStyle } from '../diff/diff-status';
import { relativeTime } from '../history/history-logic';
import { computeCommitGraph, type GraphLane, type GraphRow } from './commit-graph-layout';

const SHA_LEN = 7;
/** Gutter geometry (px). One column per lane; the node is vertically centred. */
const LANE_W = 14;
const NODE_R = 4;
const STROKE = 1.5;
const COMMIT_ROW_H = 40;
const FILE_ROW_H = 22;

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
function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const h = COMMIT_ROW_H;
  const mid = h / 2;
  const nodeX = laneX(row.col);
  const created = new Set(row.created);
  const paths: { d: string; colour: string }[] = [];

  for (const lane of row.above) {
    const x = laneX(lane.col);
    if (lane.sha === row.sha) paths.push({ d: connector(x, 0, nodeX, mid), colour: lane.colour });
    else paths.push({ d: connector(x, 0, x, mid), colour: lane.colour });
  }
  for (const lane of row.below) {
    const x = laneX(lane.col);
    if (created.has(lane.col)) paths.push({ d: connector(nodeX, mid, x, h), colour: lane.colour });
    else paths.push({ d: connector(x, mid, x, h), colour: lane.colour });
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
function ContinuationCell({ lanes, width }: { lanes: GraphLane[]; width: number }) {
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

/** One expanded commit's changed files; each opens its sha^→sha diff tab. */
function CommitFiles({
  session,
  sha,
  lanes,
  gutterW,
  onOpen,
}: {
  session: string;
  sha: string;
  lanes: GraphLane[];
  gutterW: number;
  onOpen: (path: string, sha: string) => void;
}) {
  const show = useCommitShow(session, sha);
  const note = (text: string) => (
    <div className="flex items-center" style={{ height: FILE_ROW_H }}>
      <ContinuationCell lanes={lanes} width={gutterW} />
      <span className="px-2 text-2xs text-fg-muted">{text}</span>
    </div>
  );

  if (show.isPending) return note('…');
  if (show.error) {
    return note(show.error instanceof Error ? show.error.message : 'Failed to load commit');
  }
  if (show.data.files.length === 0) return note('No file changes.');

  return (
    <>
      {show.data.files.map((entry) => {
        const style = diffStatusStyle(entry.status);
        const label =
          entry.status === 'renamed' && entry.old_path
            ? `${entry.old_path} → ${entry.path}`
            : entry.path;
        return (
          <button
            key={`${entry.status}:${entry.old_path ?? ''}:${entry.path}`}
            type="button"
            title={label}
            onClick={() => onOpen(entry.path, sha)}
            className="flex w-full items-center text-left transition-colors hover:bg-elevated"
            style={{ height: FILE_ROW_H }}
          >
            <ContinuationCell lanes={lanes} width={gutterW} />
            <span
              className={cn('mr-1.5 w-3 shrink-0 text-center font-mono text-xs', style.colourClass)}
            >
              {style.letter}
            </span>
            <span className="truncate pr-3 font-mono text-2xs text-fg">{label}</span>
          </button>
        );
      })}
    </>
  );
}

/**
 * The commit-graph panel of the Changes navigator (SPEC §8): the worktree's
 * history as an interactive DAG. Each commit is a clickable row — clicking
 * expands its changed files inline (the graph lanes carry straight through),
 * and clicking a file opens its `sha^ → sha` diff as a read-only editor tab.
 * The graph itself is a per-row SVG gutter laid out by `computeCommitGraph`.
 */
export function CommitGraph({
  session,
  onOpenCommitFile,
}: {
  session: string;
  onOpenCommitFile: (path: string, sha: string) => void;
}) {
  const log = useWorktreeLog(session);
  const [openSha, setOpenSha] = useState<string | null>(null);

  const commits = useMemo(() => log.data?.pages.flatMap((p) => p.commits) ?? [], [log.data]);
  const layout = useMemo(() => computeCommitGraph(commits), [commits]);
  const gutterW = Math.max(1, layout.laneCount) * LANE_W + LANE_W / 2;

  if (log.isPending) {
    return <div className="px-3 py-2 text-xs text-fg-muted">Loading history…</div>;
  }
  if (log.error) {
    return (
      <div className="px-3 py-2 text-xs text-fg-muted">
        {log.error instanceof Error ? log.error.message : 'Failed to load history'}
      </div>
    );
  }
  if (commits.length === 0) {
    return <div className="px-3 py-2 text-xs text-fg-muted">No commits yet.</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {layout.rows.map((row, i) => {
        const commit = commits[i]!;
        const open = openSha === row.sha;
        return (
          <div key={row.sha}>
            <button
              type="button"
              onClick={() => setOpenSha(open ? null : row.sha)}
              className={cn(
                'flex w-full items-center text-left transition-colors hover:bg-elevated',
                open && 'bg-selection',
              )}
              style={{ height: COMMIT_ROW_H }}
            >
              <GraphCell row={row} width={gutterW} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 pr-3">
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-2xs text-fg-muted">
                    {row.sha.slice(0, SHA_LEN)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-fg">{commit.subject}</span>
                </span>
                <span className="truncate text-2xs text-fg-muted">
                  {commit.author_name} ·{' '}
                  <span className="tabular-nums">{relativeTime(commit.authored_at)}</span>
                </span>
              </span>
            </button>
            {open && (
              <CommitFiles
                session={session}
                sha={row.sha}
                lanes={row.below}
                gutterW={gutterW}
                onOpen={onOpenCommitFile}
              />
            )}
          </div>
        );
      })}
      {log.hasNextPage && (
        <button
          type="button"
          onClick={() => void log.fetchNextPage()}
          disabled={log.isFetchingNextPage}
          className="px-3 py-2 text-left font-mono text-xs text-fg-muted transition-colors hover:bg-elevated"
        >
          {log.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  );
}
