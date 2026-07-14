import { useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { useCreateProject, useCreateRepo, useRepos } from '../../lib/queries';

const NEW_REPO = '__new__';

/** Pick or register a repo (absolute path on the daemon host), then name the project. */
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
  const [repoChoice, setRepoChoice] = useState<string>(NEW_REPO);
  const [repoPath, setRepoPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      let repoId: number;
      if (repoChoice === NEW_REPO) {
        const repo = await createRepo.mutateAsync({ path: repoPath.trim() });
        repoId = repo.id;
      } else {
        repoId = Number(repoChoice);
      }
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

  const ready = name.trim() !== '' && (repoChoice !== NEW_REPO || repoPath.trim() !== '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project pairs this profile with a repository and owns its sessions.
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
            <Label>Repository</Label>
            <Select value={repoChoice} onValueChange={setRepoChoice}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {repos.data?.map((repo) => (
                  <SelectItem key={repo.id} value={String(repo.id)}>
                    {repo.path}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_REPO}>Register a repository…</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {repoChoice === NEW_REPO && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repo-path">Absolute path on the daemon host</Label>
              <Input
                id="repo-path"
                placeholder="/home/you/src/my-repo"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                className="font-mono"
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              placeholder="e.g. checkout-rework"
              value={name}
              onChange={(e) => setName(e.target.value)}
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
