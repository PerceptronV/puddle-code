import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import {
  useAccounts,
  usePatchProfile,
  usePatchProfileSettings,
  useProfileSettings,
  useProfiles,
} from '../../../lib/queries';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

const NONE = '__none__';

export function ProfileSection() {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === profileId);
  const accounts = useAccounts(profileId ?? undefined);
  const settings = useProfileSettings(profileId ?? undefined);
  const patchProfile = usePatchProfile();
  const patchSettings = usePatchProfileSettings(profileId ?? 0);

  const [prefix, setPrefix] = useState('');
  useEffect(() => {
    if (profile) setPrefix(profile.branch_prefix);
  }, [profile]);

  if (!profile) return null;
  const defaultAccount = settings.data?.['default_account_id'];

  return (
    <div>
      <SectionTitle>Profile</SectionTitle>
      <SettingRow label="Name" description="Fixed in v1 — it names directories under ~/.puddle.">
        <span className="font-mono text-sm text-fg-secondary">{profile.name}</span>
      </SettingRow>
      <SettingRow
        label="Branch prefix"
        description="Session branches become <prefix><slug(title)>."
        htmlFor="branch-prefix"
      >
        <Input
          id="branch-prefix"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          className="w-44 font-mono"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={prefix === profile.branch_prefix || patchProfile.isPending}
          onClick={() =>
            patchProfile.mutate(
              { id: profile.id, branch_prefix: prefix },
              { onError: (e) => toast.error(e.message) },
            )
          }
        >
          Save
        </Button>
      </SettingRow>
      <SettingRow label="Default account" description="Preselected in the new-session modal.">
        <Select
          value={typeof defaultAccount === 'number' ? String(defaultAccount) : NONE}
          onValueChange={(value) =>
            patchSettings.mutate(
              { default_account_id: value === NONE ? null : Number(value) },
              { onError: (e) => toast.error(e.message) },
            )
          }
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>First available</SelectItem>
            {accounts.data?.map((account) => (
              <SelectItem key={account.id} value={String(account.id)}>
                <span className="font-mono">
                  {account.agent_type}/{account.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </div>
  );
}
