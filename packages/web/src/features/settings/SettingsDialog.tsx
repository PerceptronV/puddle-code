import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { closeSettings, settingsSection, useHash } from '../../lib/hash-route';

/** Route-addressable settings dialog (#settings/<section>). Sections land in workstream E. */
export function SettingsDialog() {
  const hash = useHash();
  const section = settingsSection(hash);

  return (
    <Dialog open={section !== null} onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-fg-secondary">Settings sections arrive with workstream E.</p>
      </DialogContent>
    </Dialog>
  );
}
