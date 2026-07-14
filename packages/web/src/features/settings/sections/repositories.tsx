import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { RepoWithOrphans } from '@puddle/shared';
import { Button } from '../../../components/ui/button';
import { Input, Textarea } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { useFetchRepo, usePatchRepo, useRepos } from '../../../lib/queries';
import { SectionTitle, SettingRow } from '../parts';

function RepoCard({ repo }: { repo: RepoWithOrphans }) {
  const patch = usePatchRepo();
  const fetchNow = useFetchRepo();
  const [base, setBase] = useState(repo.default_base_branch);
  const [notes, setNotes] = useState(repo.onboarding_notes ?? '');

  const onError = (e: Error) => toast.error(e.message);

  return (
    <div className="mb-4 rounded-lg bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{repo.path}</span>
        <span className="shrink-0 text-2xs text-fg-muted tabular-nums">
          {repo.last_fetched_at
            ? `fetched ${new Date(repo.last_fetched_at).toLocaleString()}`
            : 'never fetched'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={fetchNow.isPending}
          onClick={() =>
            fetchNow.mutate(repo.id, {
              onSuccess: () => toast.success('Fetched.'),
              onError,
            })
          }
        >
          <RefreshCw />
          Fetch now
        </Button>
      </div>

      <SettingRow label="Default base branch" htmlFor={`base-${repo.id}`} className="py-1.5">
        <Input
          id={`base-${repo.id}`}
          value={base}
          onChange={(e) => setBase(e.target.value)}
          className="w-40 font-mono"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={base === repo.default_base_branch || patch.isPending}
          onClick={() => patch.mutate({ id: repo.id, default_base_branch: base }, { onError })}
        >
          Save
        </Button>
      </SettingRow>
      <SettingRow
        label="Periodic fetch"
        description="fetched on open and on the daemon's interval while sessions are active."
        htmlFor={`fetch-${repo.id}`}
        className="py-1.5"
      >
        <Switch
          id={`fetch-${repo.id}`}
          checked={repo.fetch_enabled}
          onCheckedChange={(checked) =>
            patch.mutate({ id: repo.id, fetch_enabled: checked }, { onError })
          }
        />
      </SettingRow>

      <div className="mt-1.5 flex flex-col gap-1.5">
        <label htmlFor={`notes-${repo.id}`} className="flex flex-col gap-0.5 text-sm text-fg">
          Onboarding notes
          <span className="text-xs text-fg-muted">
            standing setup rules, injected into every fresh worktree. Agents update them via
            .puddle/onboarding-notes.md.
          </span>
        </label>
        <Textarea
          id={`notes-${repo.id}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          className="font-mono"
        />
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={notes === (repo.onboarding_notes ?? '') || patch.isPending}
            onClick={() => patch.mutate({ id: repo.id, onboarding_notes: notes }, { onError })}
          >
            Save notes
          </Button>
        </div>
      </div>

      {repo.orphan_worktrees.length > 0 && (
        <div className="mt-3 rounded-md bg-elevated p-2">
          <p className="text-xs text-fg-secondary">
            Orphan worktrees — directories no session claims. Puddle never deletes these
            automatically; remove them by hand if unwanted.
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {repo.orphan_worktrees.map((path) => (
              <li key={path} className="truncate font-mono text-2xs text-fg-muted">
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function RepositoriesSection() {
  const repos = useRepos();
  return (
    <div>
      <SectionTitle>Repositories</SectionTitle>
      {repos.data?.length === 0 && (
        <p className="text-sm text-fg-muted">
          No repositories yet — register one from the new-project flow on the dashboard.
        </p>
      )}
      {repos.data?.map((repo) => (
        <RepoCard key={repo.id} repo={repo} />
      ))}
    </div>
  );
}
