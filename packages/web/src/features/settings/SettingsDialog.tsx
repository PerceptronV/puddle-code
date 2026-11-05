import './settings-navigation.css';
import { ControlTray } from '../../components/ui/control-tray';
import {
  Bell,
  Code,
  FolderGit2,
  Keyboard,
  Palette,
  RefreshCw,
  Server,
  SlidersHorizontal,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { closeSettings, openSettings, useSettingsSection } from '../../lib/navigation/hash-route';
import { AppearanceSection } from './sections/appearance';
import { ProfileSection } from './sections/profile';
import { AccountsSection } from './sections/accounts';
import { SessionsSection } from './sections/sessions';
import { NotificationsSection } from './sections/notifications';
import { EditorSection } from './sections/editor';
import { HotkeysSection } from './sections/hotkeys';
import { RemoteSyncSection } from './sections/remote-sync';
import { RepositoriesSection } from './sections/repositories';
import { HostSection } from './sections/host';

const SECTIONS: Array<{ id: string; label: string; icon: LucideIcon; render: () => ReactElement }> =
  [
    { id: 'appearance', label: 'Appearance', icon: Palette, render: () => <AppearanceSection /> },
    { id: 'profile', label: 'Profile', icon: UserRound, render: () => <ProfileSection /> },
    { id: 'accounts', label: 'Accounts', icon: Users, render: () => <AccountsSection /> },
    {
      id: 'sessions',
      label: 'Sessions',
      icon: SlidersHorizontal,
      render: () => <SessionsSection />,
    },
    { id: 'editor', label: 'Editor', icon: Code, render: () => <EditorSection /> },
    { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard, render: () => <HotkeysSection /> },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: Bell,
      render: () => <NotificationsSection />,
    },
    {
      id: 'projects',
      label: 'Projects',
      icon: FolderGit2,
      render: () => <RepositoriesSection />,
    },
    { id: 'host', label: 'Host', icon: Server, render: () => <HostSection /> },
    {
      id: 'remote-sync',
      label: 'Remote & Sync',
      icon: RefreshCw,
      render: () => <RemoteSyncSection />,
    },
  ];

/** Pre-split section ids still deep-linked from old bookmarks/docs. */
const LEGACY_SECTIONS: Record<string, string> = {
  // "Terminal & Editor" split: terminal knobs joined Sessions, the rest is Editor.
  terminal: 'sessions',
  // Renamed to Projects (decision 2026-08-03): the rows are per-repository
  // settings, but users reach them thinking in projects.
  repositories: 'projects',
  remote: 'remote-sync',
  sync: 'remote-sync',
};

/** Route-addressable settings dialog: `#settings/<section>` (SPEC §11). */
export function SettingsDialog() {
  const sectionId = useSettingsSection();
  const resolvedId = sectionId !== null ? (LEGACY_SECTIONS[sectionId] ?? sectionId) : null;
  const section = SECTIONS.find((s) => s.id === resolvedId) ?? SECTIONS[0]!;

  return (
    <Dialog open={sectionId !== null} onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent
        wide
        surface={false}
        showCloseButton={false}
        className="grid h-[34rem] grid-cols-[14rem_minmax(0,1fr)] items-start gap-[var(--ui-surface-gap)] overflow-visible p-0"
      >
        <nav className="max-h-full min-h-0 overflow-y-auto rounded-[var(--ui-surface-radius)] shadow-2xl">
          <ControlTray
            label="Settings sections"
            variant="selection"
            vertical
            className="settings-navigation"
          >
            <div className="flex w-full items-center justify-between px-2.5 py-1.5">
              <DialogTitle className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
                Settings
              </DialogTitle>
              <DialogClose className="flex items-center rounded-md p-1.5 text-fg transition-colors hover:bg-ground">
                <X className="size-4" />
                <span className="sr-only">Close</span>
              </DialogClose>
            </div>
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                data-tray-slot
                aria-current={id === section.id ? 'page' : undefined}
                onClick={() => openSettings(id)}
                className="text-left text-sm transition-colors"
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </button>
            ))}
          </ControlTray>
        </nav>
        <div className="island-outline h-full min-h-0 overflow-y-auto rounded-[var(--ui-surface-radius)] bg-surface p-5 shadow-2xl">
          {section.render()}
        </div>
      </DialogContent>
    </Dialog>
  );
}
