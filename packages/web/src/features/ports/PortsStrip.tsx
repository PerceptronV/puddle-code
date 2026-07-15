import { toast } from 'sonner';
import type { Session, SessionPort } from '@puddle/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { tokenStore } from '../../lib/auth';
import { useHostInfo, useSessionPorts } from '../../lib/queries';
import { sshMode } from '../../lib/ssh-mode';
import { sshForwardCommand } from './ssh-command';

const LIVE_STATUSES: Session['status'][] = ['running', 'waiting_input'];

/**
 * Slim mono row of detected listening ports for the active session (SPEC
 * §9), rendered under the terminal — terminal view only, so diff/history
 * stay clean. Hidden entirely when the session isn't live or has no ports;
 * no refresh control, the hook's 5s poll is the refresh (HUMANS.md
 * minimalism). Each chip opens a menu with the access paths that make sense
 * for this window's mode (the CLI's `?host=` boot param — Phase 6): local
 * mode gets the direct localhost link, SSH mode the tier-2 proxy link;
 * `ssh -L` is always on offer as the manual fallback (SPEC §9).
 */
export function PortsStrip({
  sessionId,
  status,
}: {
  sessionId: string;
  status: Session['status'];
}) {
  const live = LIVE_STATUSES.includes(status);
  const { data } = useSessionPorts(sessionId, live);
  const ports = data?.ports ?? [];

  if (!live || ports.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1 font-mono text-xs">
      <span className="text-fg-muted">ports</span>
      <div className="flex items-center gap-1">
        {ports.map((port) => (
          <PortChip key={port.port} sessionId={sessionId} port={port} />
        ))}
      </div>
    </div>
  );
}

function PortChip({ sessionId, port }: { sessionId: string; port: SessionPort }) {
  const host = useHostInfo().data;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="cursor-pointer rounded px-1.5 py-0.5 tabular-nums text-fg-secondary outline-none transition-colors hover:bg-elevated hover:text-fg focus-visible:bg-elevated focus-visible:text-fg"
            >
              {port.port}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {port.command} · pid {port.pid}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {sshMode() === null ? (
          <DropdownMenuItem asChild>
            <a href={`http://localhost:${port.port}`} target="_blank" rel="noopener noreferrer">
              Open localhost
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => {
              window.open(
                `/proxy/${sessionId}/${port.port}/?puddle_token=${tokenStore.get() ?? ''}`,
                '_blank',
                'noopener,noreferrer',
              );
            }}
          >
            Open via proxy
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => {
            if (!host) return;
            void navigator.clipboard
              .writeText(sshForwardCommand(port.port, host.username, host.hostname))
              .then(() => toast.success('Copied'));
          }}
        >
          Copy ssh -L
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
