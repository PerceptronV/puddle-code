import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Bot,
  FolderOpen,
  Moon,
  MonitorCog,
  Plus,
  RefreshCw,
  Settings,
  Sun,
  TerminalSquare,
  UserRound,
} from 'lucide-react';
import type { SessionKind } from '@puddle/shared';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../../components/ui/command';
import { applyTheme } from '../../lib/theme';
import { triggerConnectionRefresh } from '../../lib/cockpit-refresh';
import { registerCommandPalette } from '../../lib/command-palette';
import { openSettings } from '../../lib/hash-route';
import { useProjects, useSessions } from '../../lib/queries';
import { collectCommands, type PaletteCommand } from './commands';
import { useCurrentProfileId, profileStore } from '../profile/profile-store';
import { useSessionTitleRenderer } from '../profile/use-session-title';

/** ⌘K palette: switch project/session, new project/agent/terminal, theme, settings (Phase 2). */
export function CommandPalette({
  onNewSession,
  onNewProject,
}: {
  /** Opens the new-session modal; `kind` picks agent (default) or terminal. */
  onNewSession?: (opts?: { kind?: SessionKind }) => void;
  onNewProject?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const params = useParams();
  const profileId = useCurrentProfileId();
  const projectId = params['id'];
  const projects = useProjects(profileId ?? undefined);
  const sessions = useSessions(projectId);
  const renderTitle = useSessionTitleRenderer();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Let any affordance (e.g. an empty pane's ⌘K button) open this one palette.
  useEffect(() => registerCommandPalette(() => setOpen(true)), []);

  const commands = useMemo(() => {
    const items: PaletteCommand[] = [];
    for (const project of projects.data ?? []) {
      items.push({
        id: `project-${project.id}`,
        group: 'Projects',
        label: project.name,
        icon: FolderOpen,
        keywords: 'switch project open',
        run: () => void navigate(`/project/${project.id}`),
      });
    }
    for (const session of sessions.data ?? []) {
      if (session.status === 'archived') continue;
      items.push({
        id: `session-${session.id}`,
        group: 'Sessions',
        label: renderTitle(session),
        icon: TerminalSquare,
        keywords: `switch session ${session.branch}`,
        run: () => void navigate(`/project/${session.project_id}/session/${session.id}`),
      });
    }
    if (projectId !== undefined && onNewSession) {
      items.push(
        {
          id: 'new-agent',
          group: 'Actions',
          label: 'New agent',
          icon: Bot,
          keywords: 'create start agent session',
          run: () => onNewSession(),
        },
        {
          id: 'new-terminal',
          group: 'Actions',
          label: 'New terminal',
          icon: TerminalSquare,
          keywords: 'create start shell session',
          run: () => onNewSession({ kind: 'terminal' }),
        },
      );
    }
    if (onNewProject) {
      items.push({
        id: 'new-project',
        group: 'Actions',
        label: 'New project',
        icon: Plus,
        keywords: 'create repository repo workspace',
        run: onNewProject,
      });
    }
    items.push(
      {
        id: 'theme-dark',
        group: 'Theme',
        label: 'Switch theme: dark',
        icon: Moon,
        run: () => void applyTheme('dark'),
      },
      {
        id: 'theme-light',
        group: 'Theme',
        label: 'Switch theme: light',
        icon: Sun,
        run: () => void applyTheme('light'),
      },
      {
        id: 'theme-system',
        group: 'Theme',
        label: 'Switch theme: system',
        icon: MonitorCog,
        run: () => void applyTheme('system'),
      },
      {
        id: 'open-settings',
        group: 'Actions',
        label: 'Settings',
        icon: Settings,
        keywords: 'preferences options configure',
        run: () => openSettings(),
      },
      {
        id: 'switch-profile',
        group: 'Actions',
        label: 'Switch profile',
        icon: UserRound,
        keywords: 'identity user change',
        run: () => profileStore.set(null),
      },
      {
        id: 'refresh-connection',
        group: 'Actions',
        label: 'Refresh connection',
        icon: RefreshCw,
        keywords: 'reconnect restart cockpit tunnel ssh daemon',
        run: () => triggerConnectionRefresh(),
      },
    );
    return [...items, ...collectCommands()];
  }, [projects.data, sessions.data, projectId, navigate, onNewSession, onNewProject, renderTitle]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, PaletteCommand[]>();
    for (const command of commands) {
      const list = byGroup.get(command.group) ?? [];
      list.push(command);
      byGroup.set(command.group, list);
    }
    return [...byGroup.entries()];
  }, [commands]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {groups.map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((command) => {
              const Icon = command.icon;
              return (
                <CommandItem
                  key={command.id}
                  value={`${command.label} ${command.keywords ?? ''}`}
                  onSelect={() => {
                    setOpen(false);
                    command.run();
                  }}
                >
                  {Icon && <Icon />}
                  {command.label}
                  {command.shortcut && <CommandShortcut>{command.shortcut}</CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
