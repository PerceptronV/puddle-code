import { LazyHuddlePane } from '../huddle/lazy-huddle';
import { Button } from '../../components/ui/button';
import { fieldSurface } from '../../components/ui/recipes';
import { useEffect, useState } from 'react';
import type { Session } from '@puddle/shared';
import { wsManager } from '../../lib/transport/ws';
import { useKeepAliveSlot } from '../workspace/keep-alive';
import { Composer } from './Composer';
import { PhoneReview } from './PhoneReview';
import '../remote/remote.css';

/** Adopts the existing terminal DOM; resizing back to desktop never recreates xterm. */
export function LocalPhonePane({
  sessions,
  selected,
  select,
}: {
  sessions: Session[];
  selected: string | null;
  select(id: string): void;
}) {
  const huddle = sessions.find((session) => session.id === selected && session.kind === 'huddle');
  const [review, setReview] = useState(false);
  const [connected, setConnected] = useState(wsManager.isConnected());
  const slot = useKeepAliveSlot(selected && !review && !huddle ? `term:${selected}` : null);
  useEffect(() => wsManager.onConnectionChange(setConnected), []);
  return (
    <div className="phone-workspace">
      <nav className="phone-selectors">
        <select
          className={fieldSurface}
          aria-label="Session"
          value={selected ?? ''}
          onChange={(event) => select(event.target.value)}
        >
          <option value="">Choose session</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title ?? session.agent_title ?? session.osc_title ?? session.id.slice(0, 8)}{' '}
              · {session.status}
            </option>
          ))}
        </select>
        <Button
          disabled={!!huddle}
          variant="secondary"
          aria-pressed={review}
          onClick={() => setReview(!review)}
        >
          {review ? 'Terminal' : 'Review'}
        </Button>
      </nav>
      {!connected && <p role="status">Reconnecting… Your draft will stay here.</p>}
      <div className="phone-view">
        {huddle ? (
          <LazyHuddlePane key={huddle.id} session={huddle} />
        ) : review && selected ? (
          <PhoneReview key={selected} session={selected} />
        ) : (
          <div ref={slot} className="size-full" />
        )}
      </div>
      {selected && !review && !huddle && (
        <Composer key={selected} session={selected} term="agent" connected={connected} />
      )}
    </div>
  );
}
