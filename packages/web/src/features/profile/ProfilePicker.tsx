import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { useCreateProfile, useProfiles } from '../../lib/queries';
import { selectProfile } from './profile-store';

/** First-load create-or-select gate (SPEC §11). */
export function ProfilePicker() {
  const profiles = useProfiles();
  const create = useCreateProfile();
  const [name, setName] = useState('');
  const [branchPrefix, setBranchPrefix] = useState('');

  const submit = () => {
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), branch_prefix: branchPrefix.trim() || `${name.trim()}/` },
      { onSuccess: (profile) => selectProfile(profile.id) },
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ground p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <h1 className="font-mono text-xl font-semibold text-fg">puddle</h1>
        <p className="mt-1 text-sm text-fg-secondary">
          Who is working? Profiles are identity, not auth — pick yours or add it.
        </p>

        {profiles.data && profiles.data.length > 0 && (
          <div className="mt-5 flex flex-col gap-1.5">
            {profiles.data.map((profile) => (
              <button
                key={profile.id}
                onClick={() => selectProfile(profile.id)}
                className="flex items-center gap-2.5 rounded-md border border-border bg-elevated px-3 py-2 text-left transition-colors hover:border-accent"
              >
                <UserRound className="size-4 text-fg-muted" />
                <span className="font-mono text-sm text-fg">{profile.name}</span>
                {profile.branch_prefix && (
                  <span className="ml-auto font-mono text-2xs text-fg-muted">
                    {profile.branch_prefix}…
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <form
          className="mt-5 flex flex-col gap-3 border-t border-border pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profile-name">New profile</Label>
            <Input
              id="profile-name"
              placeholder="e.g. alice"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus={!profiles.data?.length}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch-prefix">Branch prefix</Label>
            <Input
              id="branch-prefix"
              placeholder={name.trim() ? `${name.trim()}/` : 'e.g. alice/'}
              value={branchPrefix}
              onChange={(e) => setBranchPrefix(e.target.value)}
              className="font-mono"
            />
          </div>
          {create.error && <p className="text-xs text-danger">{create.error.message}</p>}
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Create profile
          </Button>
        </form>
      </div>
    </div>
  );
}
