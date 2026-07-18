import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import {
  registerRefreshTrigger,
  requestCockpitRefresh,
  waitForCockpitBack,
} from '../../lib/cockpit-refresh';
import { wsManager } from '../../lib/ws';

/** A blip this short (the WS manager's own reconnect usually wins) shows nothing. */
const LOST_GRACE_MS = 4000;

type Phase = 'hidden' | 'lost' | 'refreshing';

/**
 * The connection banner (SPEC §10): appears at the bottom of the shell when
 * the daemon WebSocket stays down past a grace period, offering the same
 * cockpit refresh `puddle refresh` runs — kill the cockpit, reopen the
 * tunnel, restart the daemon if needed — after which this page reloads
 * itself. Also the registered target of the ⌘K "Refresh connection" command,
 * so a refresh can be driven while nominally connected too.
 */
export function ConnectionBanner() {
  const [phase, setPhase] = useState<Phase>('hidden');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const off = wsManager.onConnectionChange((connected) => {
      if (connected) {
        if (graceTimer !== null) clearTimeout(graceTimer);
        graceTimer = null;
        // A refresh in flight keeps its banner — the reload is imminent.
        if (phaseRef.current === 'lost') setPhase('hidden');
        return;
      }
      if (graceTimer !== null || phaseRef.current !== 'hidden') return;
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (phaseRef.current === 'hidden') setPhase('lost');
      }, LOST_GRACE_MS);
    });
    return () => {
      off();
      if (graceTimer !== null) clearTimeout(graceTimer);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (phaseRef.current === 'refreshing') return;
    setPhase('refreshing');
    const settle = () => setPhase(wsManager.isConnected() ? 'hidden' : 'lost');
    if (!(await requestCockpitRefresh())) {
      toast.error('The cockpit did not accept the refresh — run `puddle refresh` in a terminal.');
      settle();
      return;
    }
    if (await waitForCockpitBack()) {
      window.location.reload();
      return;
    }
    toast.error(
      'The cockpit has not come back — it may need a terminal (ssh re-auth): puddle refresh',
    );
    settle();
  }, []);

  // The ⌘K palette drives the same flow through the trigger registry.
  useEffect(() => registerRefreshTrigger(() => void refresh()), [refresh]);

  if (phase === 'hidden') return null;
  return (
    <div className="flex shrink-0 items-center gap-3 bg-elevated px-3 py-2">
      <span className="text-xs text-fg-secondary">
        {phase === 'refreshing'
          ? 'Restarting the cockpit — this page reloads when it is back…'
          : 'Connection to the daemon lost.'}
      </span>
      {phase === 'lost' && (
        <Button size="sm" className="ml-auto" onClick={() => void refresh()}>
          <RefreshCw />
          Refresh connection
        </Button>
      )}
    </div>
  );
}
