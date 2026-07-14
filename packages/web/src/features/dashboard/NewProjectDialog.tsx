import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { HintInput, type Hint } from '../../components/ui/hint-input';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { useCreateProject, useCreateRepo, useDirSuggestions, useRepos } from '../../lib/queries';
import { useDebouncedValue } from '../../lib/use-debounced-value';

/** '/a/b/' → '/a/b'; keeps the root slash. */
function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function isPathish(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~');
}

/**
 * One path, one name: the path field autocompletes directories on the daemon
 * host (dotdirs included, git repos flagged); a path matching an already
 * registered repo simply reuses it.
 */
export function NewProjectDialog({
  profileId,
  open,
  onOpenChange,
}: {
  profileId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const repos = useRepos();
  const createRepo = useCreateRepo();
  const createProject = useCreateProject();
  const navigate = useNavigate();

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debouncedPath = useDebouncedValue(path, 150);
  const suggestions = useDirSuggestions(debouncedPath);

  // Before any typing, offer the already-registered repos.
  const hints = useMemo<Array<Hint & { is_git: boolean }>>(() => {
    if (!isPathish(path)) {
      return (repos.data ?? []).map((repo) => ({
        value: repo.path,
        badge: 'registered',
        is_git: true,
      }));
    }
    const registered = new Set((repos.data ?? []).map((repo) => repo.path));
    return (suggestions.data?.entries ?? []).map((entry) => ({
      value: entry.path,
      label: entry.name,
      badge: registered.has(entry.path) ? 'registered' : entry.is_git ? 'git' : undefined,
      is_git: entry.is_git,
    }));
  }, [path, repos.data, suggestions.data]);

  const submit = async () => {
    setError(null);
    try {
      const repoPath = normalisePath(path);
      const existing = repos.data?.find((repo) => repo.path === repoPath);
      const repoId = existing?.id ?? (await createRepo.mutateAsync({ path: repoPath })).id;
      const project = await createProject.mutateAsync({
        profile_id: profileId,
        repo_id: repoId,
        name: name.trim(),
      });
      onOpenChange(false);
      void navigate(`/project/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const ready = name.trim() !== '' && isPathish(path.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Point at a git repository on the daemon host — known repositories are reused.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="repo-path">Repository path</Label>
            <HintInput
              id="repo-path"
              placeholder="~/src/my-repo"
              value={path}
              onValueChange={setPath}
              onChoose={(hint) => {
                const chosen = hint as Hint & { is_git: boolean };
                if (!nameTouched && chosen.is_git) {
                  setName(hint.value.split('/').filter(Boolean).pop() ?? '');
                }
              }}
              hints={hints}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              placeholder="e.g. checkout-rework"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!ready || createRepo.isPending || createProject.isPending}
            >
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
