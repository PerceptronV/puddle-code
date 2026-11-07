import { useState } from 'react';
import { Archive, Bot, ChevronDown, Files, MoreHorizontal, SquareTerminal } from 'lucide-react';
import type { Project, Session, SessionKind } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '../../components/ui/dropdown-menu';
import { sessionDisplayName } from '../../lib/session-display';
import { PhoneSessionArchive } from './PhoneSessionArchive';
import {
  appearanceColourClass,
  appearanceColourStyle,
} from '../../lib/appearance/appearance-colours';
import { SessionGlyph } from '../status/SessionGlyph';

export function PhoneTerminalBar({
  session,
  sessions,
  projects,
  projectId,
  connected,
  chooseProject,
  create,
  choose,
  inspect,
  files,
}: {
  session?: Session;
  sessions: Session[];
  projects: Project[];
  projectId: string;
  connected: boolean;
  chooseProject(id: string): void;
  create(kind: SessionKind): void;
  choose(session: Session): void;
  inspect(session: Session): void;
  files(): void;
}) {
  const [archive, setArchive] = useState(false);
  const active = sessions.filter(
    (entry) => entry.project_id === projectId && entry.status !== 'archived',
  );
  return (
    <>
      <nav className="phone-workspace-bar" aria-label="Workspace view">
        <div className="phone-terminal-title">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="min-w-0 flex-1 justify-start gap-1.5 px-2 font-mono text-xs"
                aria-label="Switch session"
                title={session ? sessionDisplayName(session) : 'No sessions'}
              >
                <span className="truncate">
                  {session ? sessionDisplayName(session) : 'No sessions'}
                </span>
                <ChevronDown className="ml-auto size-3 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain"
            >
              {active.map((entry) => (
                <DropdownMenuCheckboxItem
                  key={entry.id}
                  checked={entry.id === session?.id}
                  onSelect={() => choose(entry)}
                  className="min-h-11 gap-2"
                >
                  <SessionGlyph
                    status={entry.status}
                    kind={entry.kind}
                    agentType={entry.agent_type}
                    detectedAgentType={entry.detected_agent_type}
                  />
                  <span className="truncate font-mono">{sessionDisplayName(entry)}</span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuItem
                className="min-h-11 gap-2"
                disabled={!connected}
                onSelect={() => create('agent')}
              >
                <Bot />
                New agent
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11 gap-2"
                disabled={!connected}
                onSelect={() => create('terminal')}
              >
                <SquareTerminal />
                New terminal
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-11 gap-2" onSelect={() => setArchive(true)}>
                <Archive />
                Archived sessions
              </DropdownMenuItem>
              <DropdownMenuLabel>Projects</DropdownMenuLabel>
              {projects
                .filter((entry) => !entry.archived)
                .map((entry) => (
                  <DropdownMenuItem
                    key={entry.id}
                    className="min-h-11"
                    aria-label={`Switch to ${entry.name}`}
                    onSelect={() => chooseProject(entry.id)}
                  >
                    <span
                      className={appearanceColourClass(entry.colour)}
                      style={appearanceColourStyle(entry.colour)}
                    >
                      {entry.name}
                    </span>
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {session && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label="Session details"
              onClick={() => inspect(session)}
            >
              <MoreHorizontal />
            </Button>
          )}
        </div>
        <Button variant="ghost" className="shrink-0 gap-1.5 px-2 text-xs" onClick={files}>
          <Files />
          Files
        </Button>
      </nav>
      <PhoneSessionArchive
        projects={projects}
        projectId={projectId}
        sessions={sessions}
        open={archive}
        onOpenChange={setArchive}
        inspect={inspect}
      />
    </>
  );
}
