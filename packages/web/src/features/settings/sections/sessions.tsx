import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { DEFAULT_CONCURRENT_TEMPLATE, DEFAULT_ONBOARDING_TEMPLATE } from '@puddle/shared';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Input, Textarea } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Switch } from '../../../components/ui/switch';
import { usePatchProfileSettings, useProfileSettings, useProfiles } from '../../../lib/queries';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

/** One launch-text editor: save any text (empty is allowed) or reset to default. */
function TemplateEditor({
  id,
  label,
  description,
  initial,
  defaultText,
  onSave,
  pending,
}: {
  id: string;
  label: string;
  description: string;
  initial: string;
  defaultText: string;
  onSave: (text: string) => void;
  pending: boolean;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <label htmlFor={id} className="flex flex-col gap-0.5 text-sm text-fg">
        {label}
        <span className="text-xs text-fg-muted">{description}</span>
      </label>
      <Textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        className="font-mono"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={text === initial || pending}
          onClick={() => onSave(text)}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={text === defaultText || pending}
          onClick={() => {
            setText(defaultText);
            onSave(defaultText);
          }}
        >
          Reset to default
        </Button>
      </div>
    </div>
  );
}

/**
 * Session behaviour (SPEC §4, §11): the permission-skip gate, plus the launch
 * text templates sent to an agent when it starts a fresh worktree or joins an
 * existing one. Enabling the gate demands a typed profile name; disabling is
 * immediate. The daemon enforces the gate server-side regardless of this UI.
 */
export function SessionsSection() {
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

  const saveTemplate = (key: 'onboardingTemplate' | 'concurrentTemplate') => (text: string) =>
    patch.mutate({ [key]: text }, { onError: (e) => toast.error(e.message) });

  return (
    <div>
      <SectionTitle>Sessions</SectionTitle>
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

      <div className="mt-5">
        <SectionTitle note="Sent to the agent as its opening message when a session starts. Leave a box empty to send no preamble.">
          Launch text
        </SectionTitle>
        {settings.data && (
          <>
            <TemplateEditor
              key={`${profileId}:onboarding`}
              id="onboarding-template"
              label="New worktree"
              description="For a freshly created worktree. Use {{rules}} where the repo's onboarding notes should appear."
              initial={settings.data.onboardingTemplate ?? DEFAULT_ONBOARDING_TEMPLATE}
              defaultText={DEFAULT_ONBOARDING_TEMPLATE}
              onSave={saveTemplate('onboardingTemplate')}
              pending={patch.isPending}
            />
            <TemplateEditor
              key={`${profileId}:concurrent`}
              id="concurrent-template"
              label="Existing / shared worktree"
              description="For a session joining a worktree other agents may already be working in."
              initial={settings.data.concurrentTemplate ?? DEFAULT_CONCURRENT_TEMPLATE}
              defaultText={DEFAULT_CONCURRENT_TEMPLATE}
              onSave={saveTemplate('concurrentTemplate')}
              pending={patch.isPending}
            />
          </>
        )}
      </div>

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
                <p className="text-fg-muted">
                  Opening it also records the agent&rsquo;s own bypass-permissions acceptance for
                  this profile&rsquo;s accounts, so the skip actually takes effect.
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
