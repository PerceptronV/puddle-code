import type { Project, Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { sessionDisplayName } from '../../lib/session-display';
import { SessionGlyph } from '../status/SessionGlyph';

export function PhoneSessionArchive({
  projects,
  projectId,
  sessions,
  open,
  onOpenChange,
  inspect,
}: {
  projects: Project[];
  projectId: string;
  sessions: Session[];
  open: boolean;
  onOpenChange(open: boolean): void;
  inspect(session: Session): void;
}) {
  const archived = sessions.filter(
    (session) => session.project_id === projectId && session.status === 'archived',
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archived sessions</DialogTitle>
          <DialogDescription>
            {projects.find((project) => project.id === projectId)?.name}
          </DialogDescription>
        </DialogHeader>
        {archived.length === 0 ? (
          <p className="text-sm text-fg-muted">No archived sessions in this project.</p>
        ) : (
          <div className="grid gap-1">
            {archived.map((session) => (
              <Button
                key={session.id}
                variant="ghost"
                className="h-auto justify-start py-3"
                onClick={() => {
                  onOpenChange(false);
                  inspect(session);
                }}
              >
                <SessionGlyph
                  status={session.status}
                  kind={session.kind}
                  agentType={session.agent_type}
                  detectedAgentType={session.detected_agent_type}
                />
                <span className="truncate font-mono">{sessionDisplayName(session)}</span>
              </Button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
