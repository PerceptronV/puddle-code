import { ChevronDown, Files, MoreHorizontal } from 'lucide-react';
import type { Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from '../../components/ui/dropdown-menu';
import { sessionDisplayName } from '../../lib/session-display';
import { SessionGlyph } from '../status/SessionGlyph';

export function PhoneTerminalBar({
  session,
  sessions,
  choose,
  inspect,
  files,
}: {
  session?: Session;
  sessions: Session[];
  choose(session: Session): void;
  inspect(session: Session): void;
  files(): void;
}) {
  return (
    <nav className="phone-workspace-bar" aria-label="Workspace view">
      <div className="phone-terminal-title">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="min-w-0 flex-1 justify-start gap-1.5 px-2 font-mono text-xs"
              aria-label="Switch session"
              disabled={sessions.length === 0}
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
            {sessions.map((entry) => (
              <DropdownMenuCheckboxItem
                key={entry.id}
                checked={entry.id === session?.id}
                onSelect={() => choose(entry)}
                className="min-h-10 gap-2"
              >
                <SessionGlyph
                  status={entry.status}
                  kind={entry.kind}
                  agentType={entry.agent_type}
                />
                <span className="truncate font-mono">{sessionDisplayName(entry)}</span>
              </DropdownMenuCheckboxItem>
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
  );
}
