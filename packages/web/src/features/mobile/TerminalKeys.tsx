import { useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, TextCursorInput } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ImagePasteButton } from './ImagePasteButton';
import {
  focusTerminal,
  sendTerminalInput,
  toggleTerminalModifier,
  useTerminalInputReady,
  useTerminalModifiers,
} from '../terminal/input';

export function TerminalKeys({
  session,
  term,
  connected,
  composing,
  toggleComposer,
}: {
  session: string;
  term: string;
  connected: boolean;
  composing: boolean;
  toggleComposer(): void;
}) {
  const ready = useTerminalInputReady(session, term) && connected;
  const modifiers = useTerminalModifiers(session, term);
  const [error, setError] = useState('');
  const send = (data: string) => {
    void sendTerminalInput(session, term, data).catch((error: Error) => setError(error.message));
  };
  return (
    <>
      <div className="phone-keys" role="toolbar" aria-label="Terminal keys">
        <ImagePasteButton session={session} term={term} ready={ready} />
        <Button
          variant="ghost"
          disabled={!ready}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => send('\x1b')}
        >
          Esc
        </Button>
        {(
          [
            ['Ctrl', 1],
            ['Opt', 2],
          ] as const
        ).map(([label, bit]) => (
          <Button
            key={bit}
            variant="ghost"
            disabled={!ready}
            aria-pressed={(modifiers & bit) !== 0}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              toggleTerminalModifier(session, term, bit);
              focusTerminal(session, term);
            }}
          >
            {label}
          </Button>
        ))}
        {[
          { label: 'Left', icon: ArrowLeft, data: '\x1b[D' },
          { label: 'Down', icon: ArrowDown, data: '\x1b[B' },
          { label: 'Up', icon: ArrowUp, data: '\x1b[A' },
          { label: 'Right', icon: ArrowRight, data: '\x1b[C' },
        ].map(({ label, icon: Icon, data }) => (
          <Button
            key={label}
            variant="ghost"
            aria-label={label}
            disabled={!ready}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => send(data)}
          >
            <Icon />
          </Button>
        ))}
        <Button
          variant="ghost"
          disabled={!ready}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => send('\t')}
        >
          Tab
        </Button>
        <Button
          variant="ghost"
          disabled={!ready}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => send('\r')}
        >
          Enter
        </Button>
        <Button
          variant="ghost"
          disabled={!ready}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => send('\x03')}
        >
          Ctrl-C
        </Button>
        <Button
          variant="ghost"
          aria-label="Compose prompt"
          aria-pressed={composing}
          onClick={toggleComposer}
        >
          <TextCursorInput />
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-2 text-xs text-danger">
          {error}
        </p>
      )}
    </>
  );
}
