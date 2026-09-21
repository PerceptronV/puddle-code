import { LazyTerminal } from '../terminal/LazyTerminal';
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
  return (
    <div className="phone-terminal" hidden={!active}>
      <div className="min-h-0 flex-1">
        <LazyTerminal stream={session} term={term} paused={!active || !connected} />
      </div>
      <Composer session={session} term={term} connected={connected && attached && active} compact />
    </div>
  );
}
