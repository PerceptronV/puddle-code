import { useState } from 'react';
import { browserScope } from '../../lib/browser-transport';
import { sendTerminalInput, useTerminalInputReady } from '../terminal/input';

import { Button } from '../../components/ui/button';
import { TerminalKeys } from './TerminalKeys';

/** Keyed by placement + terminal; draft storage never contains submitted history. */
export function Composer({
  session,
  term,
  connected,
  compact = false,
}: {
  session: string;
  term: string;
  connected: boolean;
  compact?: boolean;
}) {
  const ready = useTerminalInputReady(session, term) && connected;
  const storageKey = browserScope(`puddle.phone.draft:${session}:${term}`);
  const [draft, setDraft] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const [composing, setComposing] = useState(!compact || !!draft);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save = (text: string) => {
    setDraft(text);
    try {
      if (text) sessionStorage.setItem(storageKey, text);
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* The live textarea still retains the draft. */
    }
  };
  const send = async (data: string, paste = false) => {
    if (!ready || busy) return;
    setBusy(true);
    setMessage('');
    try {
      await sendTerminalInput(session, term, data, paste);
      if (paste) save('');
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Delivery is uncertain. Check the terminal before resending.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="phone-composer">
      <TerminalKeys
        session={session}
        term={term}
        connected={connected}
        composing={composing}
        toggleComposer={() => setComposing(!composing)}
      />
      {composing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (draft) void send(draft, true);
          }}
        >
          <textarea
            className="rounded-md bg-surface p-2 text-base"
            aria-label="Prompt"
            rows={2}
            value={draft}
            onChange={(e) => save(e.target.value)}
            placeholder="Write a prompt…"
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
          />
          <Button type="submit" disabled={!ready || busy || !draft}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </form>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
