import { useState } from 'react';
import { NewHuddleSource, type HuddleStartingPoint } from './NewHuddleSource';
import { supportsApplicationFeature, type Session } from '@puddle/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import { useDaemonVersion, useRepoWorktrees } from '../../../lib/queries/queries';
import {
  useHuddleAvailability,
  useHuddleDefinitions,
  useHuddleOpen,
  useHuddleSupported,
} from './queries';

export function NewHuddleDialog({
  profile,
  project,
  repo,
  onClose,
  onOpened,
}: {
  profile: string;
  project: string;
  repo: number;
  onClose(): void;
  onOpened(session: Session): void;
}) {
  const [name, setName] = useState('');
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [source, setSource] = useState<HuddleStartingPoint>({ kind: 'blank' });
  const copy = source.kind === 'copy' ? source : null;
  const protocol = useDaemonVersion().data?.protocol;
  const canCopy = supportsApplicationFeature(protocol, { major: 28, minor: 26 });
  const canStart = supportsApplicationFeature(protocol, { major: 28, minor: 27 });
  const roots = useRepoWorktrees(repo);
  const worktree =
    selectedRoot ?? roots.data?.worktrees.find((root) => root.is_primary)?.path ?? '';
  const supported = useHuddleSupported();
  const availability = useHuddleAvailability(profile, true);
  const definitions = useHuddleDefinitions(profile, project, worktree, true);
  const action = useHuddleOpen(profile);
  const saved = definitions.data?.filter((definition) => 'digest' in definition) ?? [];
  const copyValid =
    (source.kind !== 'template' || canStart) &&
    (!copy ||
      (canCopy &&
        copy.worktree === worktree &&
        saved.some(
          (definition) => definition.id === copy.id && definition.digest === copy.digest,
        )));
  const finish = (session: Session) => {
    onOpened(session);
    onClose();
  };
  const unavailable = !supported
    ? 'Use a current Puddle desktop or browser over a local or SSH connection.'
    : (availability.error?.message ??
      (availability.data?.available === false ? availability.data.reason : undefined));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !action.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New huddle</DialogTitle>
          <DialogDescription>
            {canCopy
              ? 'Choose a starting point or open a saved huddle. New graphs stay stopped.'
              : 'Create a blank graph without running it, or open a saved huddle.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !worktree ||
              !name.trim() ||
              !copyValid ||
              !availability.data?.available ||
              action.isPending
            )
              return;
            action.mutate(
              copy
                ? {
                    kind: 'duplicate',
                    value: {
                      project_id: project,
                      worktree,
                      name,
                      huddle_id: copy.id,
                      expected_digest: copy.digest,
                    },
                  }
                : {
                    kind: 'create',
                    value: {
                      project_id: project,
                      worktree,
                      name,
                      ...(source.kind === 'template' ? { template: source.template } : {}),
                    },
                  },
              { onSuccess: ({ session }) => finish(session) },
            );
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="huddle-worktree">Definition worktree</Label>
            <Select
              value={worktree}
              onValueChange={(value) => {
                if (value) {
                  setSelectedRoot(value);
                  setSource({ kind: 'blank' });
                }
              }}
              disabled={action.isPending}
            >
              <SelectTrigger id="huddle-worktree">
                <SelectValue placeholder="Choose worktree" />
              </SelectTrigger>
              <SelectContent>
                {roots.data?.worktrees.map((root) => (
                  <SelectItem key={root.path} value={root.path}>
                    {root.branch ?? 'Detached'} · {root.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(canCopy || canStart) && (
            <NewHuddleSource
              source={source}
              setSource={setSource}
              definitions={definitions.data ?? []}
              worktree={worktree}
              pending={action.isPending}
              canCopy={canCopy}
              canStart={canStart}
              valid={copyValid}
            />
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="huddle-name">Name</Label>
            <Input
              id="huddle-name"
              autoFocus
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
              disabled={action.isPending}
            />
          </div>
          {(unavailable || roots.error) && (
            <p role="status" className="text-sm text-fg-muted">
              {unavailable ?? roots.error?.message}
            </p>
          )}
          {availability.data?.available && availability.data.lifetime === 'host_session' && (
            <p className="text-sm text-fg-muted">
              This host keeps runtimes alive only for the host session.
            </p>
          )}
          {action.error && (
            <p role="alert" className="text-sm text-fg-muted">
              {action.error.message} Check saved huddles below before creating again.
            </p>
          )}
          <Button
            type="submit"
            disabled={
              !supported ||
              !availability.data?.available ||
              !worktree ||
              !name.trim() ||
              !copyValid ||
              action.isPending
            }
          >
            {copy ? 'Copy saved huddle' : 'Create huddle'}
          </Button>
        </form>
        <div className="flex max-h-56 flex-col gap-2 overflow-auto">
          <p className="text-xs text-fg-muted">Saved huddles</p>
          {definitions.error && (
            <p role="alert" className="text-sm text-fg-muted">
              {definitions.error.message}
            </p>
          )}
          {definitions.data?.length === 0 && (
            <p className="text-sm text-fg-muted">No huddles in this worktree.</p>
          )}
          {definitions.data?.map((definition) =>
            'error' in definition ? (
              <p key={definition.id} className="text-xs text-fg-muted">
                {definition.id}: {definition.error}
              </p>
            ) : (
              <button
                key={definition.id}
                type="button"
                disabled={action.isPending}
                className="rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-elevated disabled:opacity-50"
                onClick={() =>
                  action.mutate(
                    {
                      kind: 'open',
                      value: { project_id: project, worktree, huddle_id: definition.id },
                    },
                    { onSuccess: ({ session }) => finish(session) },
                  )
                }
              >
                {definition.name}
              </button>
            ),
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
