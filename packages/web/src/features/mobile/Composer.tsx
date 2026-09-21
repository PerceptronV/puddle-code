import { useState } from 'react';
import { browserScope } from '../../lib/browser-transport';
import { sendTerminalInput, useTerminalInputReady } from '../terminal/input';

const controls = [
  ['Esc', '\u001b'],
  ['Tab', '\t'],
  ['←', '\u001b[D'],
  ['↑', '\u001b[A'],
  ['↓', '\u001b[B'],
  ['→', '\u001b[C'],
  ['Enter', '\r'],
  ['Ctrl-C', '\u0003'],
] as const;

/** Keyed by placement + terminal; draft storage never contains submitted history. */
export function Composer({
  session,
  term,
  connected,
}: {
  session: string;
  term: string;
  connected: boolean;
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
      <div className="phone-keys" aria-label="Terminal keys">
        {controls.map(([label, data]) => (
          <button key={label} disabled={!ready || busy} onClick={() => void send(data)}>
            {label}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (draft) void send(draft, true);
        }}
      >
        <textarea
          aria-label="Prompt"
          rows={2}
          value={draft}
          onChange={(e) => save(e.target.value)}
          placeholder="Write a prompt…"
          autoCapitalize="sentences"
          spellCheck
        />
        <button type="submit" disabled={!ready || busy || !draft}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
