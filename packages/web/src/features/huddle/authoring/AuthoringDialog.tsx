import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Session } from '@puddle/shared';
import { useAccounts, useCreateSession, useDaemonVersion } from '../../../lib/queries/queries';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { Label } from '../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import { fieldSurface } from '../../../components/ui/recipes';
import {
  accountPickerLabel,
  orderAccountPickerItems,
} from '../../workspace/sessions/account-picker-order';
import { huddleAuthoringRequest } from './context';

export function AuthoringDialog({
  profile,
  session,
  blocked,
  onClose,
}: {
  profile: string;
  session: Session;
  blocked: boolean;
  onClose(): void;
}) {
  const id = useId();
  const accounts = useAccounts(profile);
  const protocol = useDaemonVersion().data?.protocol;
  const create = useCreateSession();
  const navigate = useNavigate();
  const [account, setAccount] = useState('');
  const [task, setTask] = useState('');
  // The ordinary creation API has no idempotency token. One attempt per review,
  // including a lost response; reopening is a fresh explicit user action.
  const attempted = useRef(false);
  const choices = orderAccountPickerItems(
    (accounts.data ?? []).filter((item) => item.profile_id === profile),
  );
  const selected = choices.find((item) => String(item.id) === account);
  const ready =
    !blocked && !!protocol && !accounts.isError && !!selected?.logged_in && !!task.trim();
  const submit = () => {
    if (!ready || !selected || !protocol || attempted.current) return;
    attempted.current = true;
    create.mutate(huddleAuthoringRequest(session, profile, protocol, selected.id, task), {
      onSuccess: (agent) => {
        onClose();
        void navigate(`/project/${agent.project_id}/session/${agent.id}`);
      },
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!create.isPending}>
        <DialogTitle>Edit huddle with agent</DialogTitle>
        <DialogDescription>
          Start a coding agent in this worktree with the huddle authoring skill and your task. Its
          edits remain saved source until you explicitly apply them. Normal agent permissions apply.
        </DialogDescription>
        <p className="break-all text-xs text-fg-muted">
          {session.worktree_path.replace(/\/$/, '')}/.puddle/huddle/{session.huddle_id}/
        </p>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-account`}>Authoring account</Label>
            <Select
              value={account}
              onValueChange={setAccount}
              disabled={create.isPending || attempted.current}
            >
              <SelectTrigger id={`${id}-account`}>
                <SelectValue placeholder="Choose account" />
              </SelectTrigger>
              <SelectContent>
                {account && !selected && (
                  <SelectItem value={account} disabled>
                    Unavailable account ({account})
                  </SelectItem>
                )}
                {choices.map((item) => (
                  <SelectItem key={item.id} value={String(item.id)} disabled={!item.logged_in}>
                    {accountPickerLabel(item)}
                    {!item.logged_in ? ' · logged out' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              className="self-start text-xs text-fg-muted hover:text-fg disabled:opacity-50"
              disabled={accounts.isFetching || create.isPending || attempted.current}
              onClick={() => void accounts.refetch()}
            >
              Refresh accounts
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-task`}>Task</Label>
            <textarea
              id={`${id}-task`}
              className={`${fieldSurface} min-h-28 resize-y p-2 text-sm`}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              disabled={create.isPending || attempted.current}
              maxLength={16000}
            />
          </div>
          {(blocked || accounts.isError || (account && !selected?.logged_in)) && (
            <p role="status" className="text-xs text-fg-muted">
              {blocked
                ? 'Save or resolve source edits before continuing. Archived huddles cannot start an authoring agent.'
                : accounts.isError
                  ? 'Accounts are unavailable. Refresh before continuing.'
                  : 'The selected account is unavailable. Choose an available account explicitly.'}
            </p>
          )}
          {create.error && (
            <p role="alert" className="text-xs text-fg-muted">
              {create.error.message} A session may have been created. Close this dialog and check
              the session list before trying again.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={create.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || create.isPending || attempted.current}>
              {create.isPending ? 'Starting…' : 'Start authoring agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
