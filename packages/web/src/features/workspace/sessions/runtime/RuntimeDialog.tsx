import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  sessionRuntimeInspectionSchema,
  sessionSchema,
  type Session,
  type SessionRuntimeInspection,
} from '@puddle/shared';
import { api } from '../../../../lib/transport/api';
import { Button } from '../../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../../../components/ui/dialog';

type Blocker = Extract<SessionRuntimeInspection['restart'], { available: false }>['reason'];
const reasons: Record<Blocker, string> = {
  no_live_runtime: 'This session has no running persistent runtime.',
  runtime_unavailable: 'The runtime is unavailable. Reconnect before restarting it.',
  runtime_changed: 'The runtime moved to another session. Open its current session to inspect it.',
  release_unavailable: 'The installed runtime software is unavailable.',
  conversation_unknown: 'The exact native conversation is not available for resuming.',
  resume_unsupported: 'This agent cannot resume its native conversation.',
  worktree_missing: 'The session’s working directory is missing.',
  state_not_saved: 'Runtime state has not finished saving. Refresh before restarting.',
};

/** Mounted only while open; inspections never cause a restart or a native-store scan. */
export function RuntimeDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const client = useQueryClient();
  const key = ['session-runtime', session.id];
  const path = `/api/sessions/${session.id}/runtime`;
  const query = useQuery({
    queryKey: key,
    queryFn: async () => sessionRuntimeInspectionSchema.parse(await api('GET', path)),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const restart = useMutation({
    mutationKey: key,
    retry: false,
    networkMode: 'always',
    mutationFn: async (fingerprint: string) =>
      sessionSchema.parse(await api('POST', `${path}/restart`, { fingerprint })),
    onMutate: () => client.cancelQueries({ queryKey: key }),
    onSettled: async () => {
      // A lost reply may follow a successful replacement. Refresh instead of replaying.
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: ['sessions'] }),
        client.invalidateQueries({ queryKey: ['project', session.project_id] }),
        client.invalidateQueries({ queryKey: ['frontend-host-updates'] }),
      ]);
    },
  });
  const data = query.data;
  const ready = data?.restart.available ? data.restart.fingerprint : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !restart.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          Runtime · {session.title || session.agent_title || session.id.slice(0, 8)}
        </DialogTitle>
        <DialogDescription>
          Inspect this session’s running software. Updating the installed default leaves existing
          runtimes running.
        </DialogDescription>
        {data && (
          <div className="space-y-3 text-sm">
            <p>
              Running build: {data.runtime?.version ?? 'None'}
              {data.runtime && !data.runtime.connected && ' · disconnected'}
            </p>
            <p>Installed default: {data.installed?.version ?? 'Unavailable'}</p>
            {data.runtime?.lifetime === 'host_session' && (
              <p className="text-xs text-warning">
                Host-session lifetime: this host may stop the runtime when its login or SSH session
                ends. Daemon updates are blocked while it is running.
              </p>
            )}
            {data.runtime &&
              data.runtime.lifetime !== 'service' &&
              data.runtime.lifetime !== 'host_session' && (
                <p className="text-xs text-fg-muted">Runtime lifetime could not be verified.</p>
              )}
            {data.runtime?.terminals && (
              <div>
                <p className="text-fg-secondary">Affected terminals</p>
                <ul className="mt-1 space-y-1 text-xs text-fg-muted">
                  {data.runtime.terminals.map(({ term }) => (
                    <li key={term}>
                      {term === 'agent'
                        ? session.kind === 'agent'
                          ? `Main agent (${session.agent_type})`
                          : 'Main terminal'
                        : `Shell ${term.replace('shell-', '')}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!data.restart.available && (
              <p className="text-xs text-fg-muted">{reasons[data.restart.reason]}</p>
            )}
            {ready && (
              <p className="text-xs text-warning">
                Restart stops this runtime and all listed terminals. Shell jobs and in-memory
                process state are lost; extra shell tabs are closed.{' '}
                {session.kind === 'agent'
                  ? 'The agent resumes its exact native conversation.'
                  : 'A fresh shell opens in the saved directory.'}{' '}
                Commands and interrupted programmes are not replayed.
              </p>
            )}
          </div>
        )}
        {query.isPending && (
          <p role="status" className="text-sm text-fg-muted">
            Inspecting runtime…
          </p>
        )}
        {query.isError && (
          <p role="alert" className="text-sm text-warning">
            Runtime inspection is unavailable. Refresh before another action.
          </p>
        )}
        {restart.isError && (
          <p role="alert" className="text-sm text-warning">
            {restart.error.message} Inspect the current runtime before another action; the restart
            was not repeated.
          </p>
        )}
        {restart.isSuccess && (
          <p role="status" className="text-sm text-fg-secondary">
            The replacement was observed. Its current state is shown above.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={restart.isPending} onClick={onClose}>
            Close
          </Button>
          <Button
            variant="ghost"
            disabled={query.isFetching || restart.isPending}
            onClick={() => void query.refetch({ cancelRefetch: false })}
          >
            Refresh
          </Button>
          {ready && (
            <Button
              variant="danger"
              disabled={query.isFetching || query.isError || restart.isPending}
              onClick={() => {
                if (!client.isMutating({ mutationKey: key })) restart.mutate(ready);
              }}
            >
              {restart.isPending ? 'Restarting…' : `Restart on ${data?.installed?.version}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
