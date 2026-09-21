import { useEffect, useState } from 'react';
import { proxyGrantResponseSchema } from '@puddle/shared';
import { api } from '../../lib/api';

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
    void api('POST', '/cockpit/proxy-grant', {
      session: match[1],
      port: Number(match[2]),
      path: new URLSearchParams(window.location.search).get('path') ?? '/',
    })
      .then((body) => {
        if (active) window.location.replace(proxyGrantResponseSchema.parse(body).url);
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
