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
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { menuHighlightCmdk, menuRow } from '../../components/ui/recipes';
import { useCreateProject, useCreateRepo, useDirSuggestions, useRepos } from '../../lib/queries';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { cn } from '../../lib/utils';

/** '/a/b/' → '/a/b'; keeps the root slash. */
function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
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
  const [hintsOpen, setHintsOpen] = useState(false);
  const [activeHint, setActiveHint] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const debouncedPath = useDebouncedValue(path, 150);
  const suggestions = useDirSuggestions(debouncedPath);

  // Before any typing, offer the already-registered repos.
  const hints = useMemo(() => {
    if (!path.startsWith('/')) {
      return (repos.data ?? []).map((repo) => ({
        path: repo.path,
        name: repo.path,
        is_git: true,
        registered: true,
      }));
    }
    const registeredPaths = new Set((repos.data ?? []).map((repo) => repo.path));
    return (suggestions.data?.entries ?? []).map((entry) => ({
      ...entry,
      registered: registeredPaths.has(entry.path),
    }));
  }, [path, repos.data, suggestions.data]);

  const choose = (hint: { path: string; is_git: boolean }) => {
    setPath(hint.path);
    if (!nameTouched && hint.is_git) {
      setName(hint.path.split('/').filter(Boolean).pop() ?? '');
    }
    setHintsOpen(false);
  };

  const onPathKeyDown = (e: React.KeyboardEvent) => {
    if (!hintsOpen || hints.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveHint((i) => (i + 1) % hints.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveHint((i) => (i - 1 + hints.length) % hints.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const hint = hints[activeHint] ?? hints[0];
      if (hint) {
        e.preventDefault();
        choose(hint);
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // close the hints, not the dialog
      setHintsOpen(false);
    }
  };

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

  const ready = name.trim() !== '' && path.trim().startsWith('/');

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
          <div className="relative flex flex-col gap-1.5">
            <Label htmlFor="repo-path">Repository path</Label>
            <Input
              id="repo-path"
              placeholder="/home/you/src/my-repo"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setHintsOpen(true);
                setActiveHint(0);
              }}
              onFocus={() => setHintsOpen(true)}
              onBlur={() => setHintsOpen(false)}
              onKeyDown={onPathKeyDown}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            {hintsOpen && hints.length > 0 && (
              <ul className="absolute top-full z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md bg-elevated p-1 shadow-xl">
                {hints.map((hint, index) => (
                  <li key={hint.path}>
                    <button
                      type="button"
                      // Fires before the input's blur closes the list.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(hint);
                      }}
                      onMouseEnter={() => setActiveHint(index)}
                      className={cn(menuRow, menuHighlightCmdk, 'w-full font-mono text-xs')}
                      data-selected={index === activeHint}
                    >
                      <span className="truncate">{hint.name}</span>
                      {hint.registered ? (
                        <span className="ml-auto shrink-0 text-2xs opacity-70">registered</span>
                      ) : hint.is_git ? (
                        <span className="ml-auto shrink-0 text-2xs opacity-70">git</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
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
