import { useEffect } from 'react';
import { toast } from 'sonner';
import { hostLabel, useHostInfo } from '../../lib/queries/queries';
import { openSettings } from '../../lib/navigation/hash-route';
import { browserTransport } from '../../lib/transport/browser-transport';
import { availableHostUpdates, HostUpdateOffers } from './model';
import { useHostUpdateEvents, useHostUpdates } from './queries';

const offers = new HostUpdateOffers();

export function HostUpdateToast() {
  const status = useHostUpdates();
  const name = hostLabel(useHostInfo().data);
  useHostUpdateEvents();
  useEffect(() => {
    if (browserTransport() || !name || status.isError) return;
    for (const target of offers.take(window.location.origin, availableHostUpdates(status.data))) {
      const component = target.component === 'daemon' ? 'Daemon' : 'Runtime software';
      toast(`${name}: ${component} ${target.version} is available.`, {
        id: `host-update-${target.component}-${target.version}`,
        duration: Infinity,
        closeButton: true,
        action: { label: 'Review update', onClick: () => openSettings('host') },
      });
    }
  }, [status.data, status.isError, name]);
  return null;
}
