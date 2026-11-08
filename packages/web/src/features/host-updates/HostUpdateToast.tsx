import { useEffect } from 'react';
import { toast } from 'sonner';
import { hostLabel, useHostInfo } from '../../lib/queries/queries';
import { openSettings } from '../../lib/navigation/hash-route';
import { availableHostUpdates, HostUpdateOffers } from './model';
import { useHostUpdateAccess, useHostUpdateEvents, useHostUpdates } from './queries';
import { hostUpdateScope } from './transport';
import { useHostOffersOwner } from '../windows/effects/host-offers';

const offers = new HostUpdateOffers();
const visibleOffers = new Set<string>();

export function HostUpdateToast({ onReview }: { onReview?: () => void } = {}) {
  const owner = useHostOffersOwner();
  // Invalidation is cheap and still serves an independently opened Settings view.
  useHostUpdateEvents();
  useEffect(() => {
    if (owner !== false) return;
    for (const id of visibleOffers) toast.dismiss(id);
    visibleOffers.clear();
  }, [owner]);
  return owner ? <OwnedHostUpdateToast onReview={onReview} /> : null;
}

function OwnedHostUpdateToast({ onReview }: { onReview?: () => void }) {
  const status = useHostUpdates();
  const allowed = useHostUpdateAccess();
  const name = hostLabel(useHostInfo().data);
  const scope = hostUpdateScope();
  useEffect(() => {
    if (!allowed || !name || status.isError) return;
    for (const target of offers.take(scope, availableHostUpdates(status.data))) {
      const component = target.component === 'daemon' ? 'Daemon' : 'Runtime software';
      const id = `host-update-${scope}-${target.component}-${target.version}`;
      visibleOffers.add(id);
      toast(`${name}: ${component} ${target.version} is available.`, {
        id,
        duration: Infinity,
        closeButton: true,
        action: { label: 'Review update', onClick: onReview ?? (() => openSettings('host')) },
      });
    }
  }, [status.data, status.isError, name, allowed, scope, onReview]);
  return null;
}
