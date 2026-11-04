import { useEffect } from 'react';
import { toast } from 'sonner';
import { hostLabel, useHostInfo } from '../../lib/queries/queries';
import { openSettings } from '../../lib/navigation/hash-route';
import { availableHostUpdates, HostUpdateOffers } from './model';
import { useHostUpdateAccess, useHostUpdateEvents, useHostUpdates } from './queries';
import { hostUpdateScope } from './transport';

const offers = new HostUpdateOffers();

export function HostUpdateToast({ onReview }: { onReview?: () => void } = {}) {
  const status = useHostUpdates();
  const allowed = useHostUpdateAccess();
  const name = hostLabel(useHostInfo().data);
  const scope = hostUpdateScope();
  useHostUpdateEvents();
  useEffect(() => {
    if (!allowed || !name || status.isError) return;
    for (const target of offers.take(scope, availableHostUpdates(status.data))) {
      const component = target.component === 'daemon' ? 'Daemon' : 'Runtime software';
      const id = `host-update-${scope}-${target.component}-${target.version}`;
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
