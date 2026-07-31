import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CornerLeftUp, Folder, FolderGit2 } from 'lucide-react';
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
import {
  useCreateProject,
  useCreateRepo,
  useDirSuggestions,
  useHostInfo,
  useRepos,
} from '../../lib/queries';
import { tildify } from '../../lib/tildify';
import { useDebouncedValue } from '../../lib/use-debounced-value';

/** '/a/b/' → '/a/b'; keeps the root slash. */
function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function isPathish(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~');
}

function parentDir(dir: string): string {
  const cut = dir.replace(/\/+$/, '');
  const idx = cut.lastIndexOf('/');
  return idx <= 0 ? '/' : cut.slice(0, idx);
}

/**
 * The graphical folder picker behind "browse…": walks the DAEMON host's
 * directories over the same `GET /api/fs/dirs` the path field's autocomplete
 * uses, so it works identically for local and SSH hosts — no OS file dialog
 * (which could only ever see the client machine). Clicking a git repository
 * chooses it; a plain directory descends; the header steps up and can choose
 * the current directory itself.
 */
function DirBrowser({
  dir,
  home,
  onNavigate,
  onChoose,
}: {
  dir: string;
  home: string | undefined;
  onNavigate: (dir: string) => void;
  onChoose: (dir: string, isGit: boolean) => void;
}) {
  const entries = useDirSuggestions(dir.endsWith('/') ? dir : `${dir}/`);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onNavigate(parentDir(dir))}
          disabled={dir === '/'}
          title="Parent directory"
          className="shrink-0 rounded-sm p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          <CornerLeftUp className="size-3.5" />
          <span className="sr-only">Parent directory</span>
        </button>
        <span className="min-w-0 truncate font-mono text-xs text-fg-secondary">
          {tildify(dir, home)}
        </span>
        <button
          type="button"
          onClick={() => onChoose(dir, false)}
          className="ml-auto shrink-0 text-2xs text-fg-muted transition-colors hover:text-fg"
        >
          choose this folder
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {(entries.data?.entries ?? []).map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => (entry.is_git ? onChoose(entry.path, true) : onNavigate(entry.path))}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-elevated"
          >
            {entry.is_git ? (
              <FolderGit2 className="size-3.5 shrink-0 text-success" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-fg-gold" />
            )}
            <span className="truncate font-mono text-xs text-fg">{entry.name}</span>
            {entry.is_git && <span className="ml-auto text-2xs text-fg-muted">git</span>}
          </button>
        ))}
        {entries.data !== undefined && entries.data.entries.length === 0 && (
          <p className="px-2 py-1 text-xs text-fg-muted">No subdirectories.</p>
        )}
      </div>
    </div>
  );
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
  profileId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const repos = useRepos();
  const createRepo = useCreateRepo();
  const createProject = useCreateProject();
  const navigate = useNavigate();
  const host = useHostInfo();

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The picker's current directory; null while it is closed.
  const [browseDir, setBrowseDir] = useState<string | null>(null);

  const home = host.data?.home;
  const openBrowser = () => {
    // Seed from the typed path when there is one (~-expanded client-side so
    // parent stepping stays plain string maths), else the daemon user's home.
    const typed = path.trim();
    const seeded =
      isPathish(typed) && home !== undefined
        ? normalisePath(typed.replace(/^~(?=\/|$)/, home))
        : isPathish(typed) && typed.startsWith('/')
          ? normalisePath(typed)
          : (home ?? '/');
    setBrowseDir(seeded);
  };
  const chooseDir = (dir: string, isGit: boolean) => {
    setPath(dir);
    setBrowseDir(null);
    if (!nameTouched && isGit) setName(dir.split('/').filter(Boolean).pop() ?? '');
  };

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
            <div className="flex items-center justify-between">
              <Label htmlFor="repo-path">Repository path</Label>
              <button
                type="button"
                onClick={() => (browseDir === null ? openBrowser() : setBrowseDir(null))}
                className="text-2xs text-fg-muted transition-colors hover:text-fg"
              >
                {browseDir === null ? 'browse…' : 'hide browser'}
              </button>
            </div>
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
            {browseDir !== null && (
              <DirBrowser
                dir={browseDir}
                home={home}
                onNavigate={setBrowseDir}
                onChoose={chooseDir}
              />
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
