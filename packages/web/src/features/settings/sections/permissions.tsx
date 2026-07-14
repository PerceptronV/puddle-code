import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Switch } from '../../../components/ui/switch';
import { usePatchProfileSettings, useProfileSettings, useProfiles } from '../../../lib/queries';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

/**
 * The §11 gate. Enabling demands a typed profile name; disabling is immediate
 * and hides every skip toggle. The daemon enforces the gate server-side
 * regardless of anything this UI does.
 */
export function PermissionsSection() {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === profileId);
  const settings = useProfileSettings(profileId ?? undefined);
  const patch = usePatchProfileSettings(profileId ?? '');
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  const gateOpen = settings.data?.allowSkipPermissions === true;

  const setGate = (value: boolean) =>
    patch.mutate(
      { allowSkipPermissions: value },
      {
        onSuccess: () => {
          setConfirming(false);
          setTyped('');
        },
        onError: (e) => toast.error(e.message),
      },
    );

  return (
    <div>
      <SectionTitle>Permissions &amp; safety</SectionTitle>
      <p className="mb-3 text-xs text-fg-secondary">
        Permission prompts are on by default, everywhere. Skipping them requires this profile gate,
        a per-account opt-in, and a per-session toggle — and the daemon re-checks all three on every
        launch, resume, and hand-off.
      </p>
      <SettingRow
        label="Allow skipping permission prompts"
        description={
          gateOpen
            ? 'The gate is open: opted-in accounts can start prompt-free sessions.'
            : 'The gate is closed: every session keeps its permission prompts.'
        }
        htmlFor="gate"
      >
        <Switch
          id="gate"
          checked={gateOpen}
          onCheckedChange={(checked) => {
            if (checked) setConfirming(true);
            else setGate(false); // closing is immediate (SPEC §11)
          }}
        />
      </SettingRow>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(false);
            setTyped('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-danger" />
              Run agents without permission prompts?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm">
                <p>
                  A prompt-free agent acts unattended, with your credentials, inside its worktree —
                  and nothing technically stops a shell command from reaching outside it. It can:
                </p>
                <ul className="list-disc pl-5 text-fg-secondary">
                  <li>run any shell command without asking first,</li>
                  <li>modify, delete, or exfiltrate files your user can reach,</li>
                  <li>install dependencies and execute the network requests they make,</li>
                  <li>push branches or call remote APIs with the credentials it finds.</li>
                </ul>
                <p>
                  Only open this gate if every account you opt in runs work you would trust a
                  colleague to run unsupervised on this machine.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-name">
              Type <span className="font-mono text-fg">{profile?.name}</span> to confirm
            </Label>
            <Input
              id="confirm-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="font-mono"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setTyped('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={typed !== profile?.name || patch.isPending}
              onClick={() => setGate(true)}
            >
              Open the gate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
