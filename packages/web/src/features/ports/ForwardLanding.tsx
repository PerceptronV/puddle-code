import { useEffect, useState } from 'react';
import { forwardingInvitation } from './forward-link';

/** Reusable public link; authority is obtained only inside the trusted cockpit. */
export function ForwardLanding() {
  const [message, setMessage] = useState('Opening forwarded application…');
  useEffect(() => {
    const match = /^\/forward\/([^/]+)\/(\d+)$/.exec(window.location.pathname);
    if (!match) {
      setMessage('This forwarding link is invalid.');
      return;
    }
    let active = true;
    void forwardingInvitation(new URL(window.location.href))
      .then((url) => {
        if (active) window.location.replace(url);
      })
      .catch(() => {
        if (active)
          setMessage(
            'The application is unavailable. Reconnect to Puddle and open this link again.',
          );
      });
    return () => {
      active = false;
    };
  }, []);
  return <p className="p-8 text-sm text-fg-secondary">{message}</p>;
}
