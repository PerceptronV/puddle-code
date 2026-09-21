import { useRef } from 'react';
import { LazyTerminal } from '../terminal/LazyTerminal';
import { focusTerminal } from '../terminal/input';
import { Composer } from './Composer';

export function MobileTerminal({
  session,
  term,
  active,
  connected,
  attached,
}: {
  session: string;
  term: string;
  active: boolean;
  connected: boolean;
  attached: boolean;
}) {
  const touch = useRef({ x: 0, y: 0, at: 0 });
  return (
    <div className="phone-terminal" hidden={!active}>
      <div
        className="min-h-0 flex-1"
        onPointerDown={(event) => {
          touch.current = { x: event.clientX, y: event.clientY, at: performance.now() };
        }}
        onPointerUp={(event) => {
          if (
            event.pointerType === 'touch' &&
            connected &&
            performance.now() - touch.current.at < 300 &&
            Math.hypot(event.clientX - touch.current.x, event.clientY - touch.current.y) < 10
          )
            focusTerminal(session, term);
        }}
      >
        <LazyTerminal stream={session} term={term} paused={!active || !connected} />
      </div>
      <Composer session={session} term={term} connected={connected && attached && active} compact />
    </div>
  );
}
