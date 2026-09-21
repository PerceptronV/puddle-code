import { useState } from 'react';
import type { Session } from '@puddle/shared';
import { api } from '../../lib/api';
import { wsManager } from '../../lib/ws';

export function SessionActions({
  session,
  connected,
  attached,
  busy,
  action,
  shell,
}: {
  session: Session;
  connected: boolean;
  attached: boolean;
  busy: boolean;
  action(fn: () => Promise<void>): Promise<void>;
  shell(term: string): void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  return (
    <details>
      <summary>Session actions</summary>
      <button
        disabled={!attached || busy}
        onClick={() => void action(async () => shell(await wsManager.spawnShell(session.id)))}
      >
        Add shell
      </button>
      <button
        disabled={!connected || busy}
        onClick={() => {
          setTitle(session.title ?? '');
          setRenaming(!renaming);
        }}
      >
        Rename
      </button>
      {renaming && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await api('PATCH', `/api/sessions/${session.id}`, { title });
              setRenaming(false);
            });
          }}
        >
          <label>
            Title
            <input
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!connected || busy}>
            Save title
          </button>
        </form>
      )}
      {(['resume', 'kill', session.status === 'archived' ? 'unarchive' : 'archive'] as const).map(
        (operation) => (
          <button
            key={operation}
            disabled={!connected || busy}
            onClick={() =>
              void action(async () => {
                await api('POST', `/api/sessions/${session.id}/${operation}`);
              })
            }
          >
            {operation === 'kill'
              ? 'Stop session'
              : operation === 'resume'
                ? 'Resume'
                : operation === 'archive'
                  ? 'Archive'
                  : 'Unarchive'}
          </button>
        ),
      )}
    </details>
  );
}
