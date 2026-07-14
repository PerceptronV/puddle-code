import {
  Bell,
  FolderGit2,
  Palette,
  Server,
  ShieldAlert,
  TerminalSquare,
  UserRound,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { closeSettings, settingsSection, useHash } from '../../lib/hash-route';
import { cn } from '../../lib/utils';
import { AppearanceSection } from './sections/appearance';
import { ProfileSection } from './sections/profile';
import { AccountsSection } from './sections/accounts';
import { PermissionsSection } from './sections/permissions';
import { NotificationsSection } from './sections/notifications';
import { TerminalSection } from './sections/terminal';
import { RepositoriesSection } from './sections/repositories';
import { HostSection } from './sections/host';

const SECTIONS: Array<{ id: string; label: string; icon: LucideIcon; render: () => ReactElement }> =
  [
    { id: 'appearance', label: 'Appearance', icon: Palette, render: () => <AppearanceSection /> },
    { id: 'profile', label: 'Profile', icon: UserRound, render: () => <ProfileSection /> },
    { id: 'accounts', label: 'Accounts', icon: Users, render: () => <AccountsSection /> },
    {
      id: 'permissions',
      label: 'Permissions & safety',
      icon: ShieldAlert,
      render: () => <PermissionsSection />,
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: Bell,
      render: () => <NotificationsSection />,
    },
    {
      id: 'terminal',
      label: 'Terminal & editor',
      icon: TerminalSquare,
      render: () => <TerminalSection />,
    },
    {
      id: 'repositories',
      label: 'Repositories',
      icon: FolderGit2,
      render: () => <RepositoriesSection />,
    },
    { id: 'host', label: 'Host', icon: Server, render: () => <HostSection /> },
  ];

/** Route-addressable settings dialog: `#settings/<section>` (SPEC §11). */
export function SettingsDialog() {
  const hash = useHash();
  const sectionId = settingsSection(hash);
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0]!;

  return (
    <Dialog open={sectionId !== null} onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent
        wide
        className="grid h-[34rem] grid-cols-[11rem_1fr] gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <nav className="flex flex-col gap-0.5 border-r border-border bg-surface p-2">
          <span className="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-fg-muted">
            Settings
          </span>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => {
                window.location.hash = `settings/${id}`;
              }}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                id === section.id
                  ? 'bg-elevated text-fg'
                  : 'text-fg-secondary hover:bg-elevated hover:text-fg',
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
        <div className="overflow-y-auto p-5">{section.render()}</div>
      </DialogContent>
    </Dialog>
  );
}
