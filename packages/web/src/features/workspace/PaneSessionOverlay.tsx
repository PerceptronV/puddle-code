import { Play } from 'lucide-react';
import { toast } from 'sonner';
import type { Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { useSessionAction } from '../../lib/queries';
import { PortsStrip } from '../ports/PortsStrip';

const RESUMABLE: Session['status'][] = ['interrupted', 'exited'];

/**
 * Per-pane session controls, overlaid INSIDE the pane at its bottom-right
 * (SPEC §8/§9): a plain Resume button for an interrupted/exited session — no
 * verbose banner, the status dot on the tab already tells the story — and the
 * session's ports chips. Rendered by whichever pane's ACTIVE tab is the
 * session's terminal (agent and plain-terminal sessions alike), so the
 * controls sit on the session they belong to; the old placement at the bottom
 * of the whole workspace read as global and detached from its session. The
 * wrapper is click-transparent — only the controls take the pointer, the
 * terminal beneath stays fully interactive.
 */
export function PaneSessionOverlay({ session }: { session: Session }) {
  const resume = useSessionAction('resume');
  const resumable = RESUMABLE.includes(session.status) && !session.worktree_missing;
  return (
    <div className="pointer-events-none absolute bottom-2 right-3 z-10 flex items-center gap-2">
      {/* Translucent surface fill so chips stay legible over terminal text
          (a fill, not a border — HUMANS.md); collapses to nothing when the
          strip renders empty. */}
      <div className="pointer-events-auto rounded-md bg-surface/90">
        <PortsStrip sessionId={session.id} status={session.status} />
      </div>
      {resumable && (
        <Button
          size="sm"
          className="pointer-events-auto"
          disabled={resume.isPending}
          onClick={() => resume.mutate(session.id, { onError: (e) => toast.error(e.message) })}
        >
          <Play />
          Resume
        </Button>
      )}
    </div>
  );
}
