import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '../../components/ui/sonner';
import { ErrorBoundary } from '../../components/error-boundary';
import { TooltipProvider } from '../../components/ui/tooltip';
import { installBrowserTransport } from '../../lib/browser-transport';
import { wsManager } from '../../lib/ws';
import { DeviceAccess } from './DeviceAccess';
import { PhoneWorkspace } from '../mobile/PhoneWorkspace';
import { usePhoneViewport } from '../mobile/use-phone-viewport';
import type { RemoteClient } from './client';

export function ConnectedHost({ client, leave }: { client: RemoteClient; leave(): void }) {
  usePhoneViewport();
  const [state, setState] = useState(client.state);
  const [admitted, setAdmitted] = useState(false);
  const [devices, setDevices] = useState(false);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 5_000 },
          mutations: { retry: false },
        },
      }),
  );
  useEffect(() => {
    installBrowserTransport(client);
    wsManager.switchHost();
    const off = client.onState(() => {
      setState(client.state);
      if (client.state === 'ready') {
        setAdmitted(true);
        void queryClient.invalidateQueries();
      }
    });
    client.start();
    return () => {
      off();
      client.close();
      wsManager.switchHost();
      installBrowserTransport(null);
      queryClient.clear();
    };
  }, [client, queryClient]);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <ErrorBoundary scope="remote host">
          <div className="remote-connected">
            <header>
              <button onClick={leave}>Hosts</button>
              <span role="status">
                {state === 'ready'
                  ? 'Connected'
                  : state === 'pairing'
                    ? 'Waiting for host approval'
                    : state === 'rejected'
                      ? 'Pairing required or access revoked'
                      : 'Reconnecting…'}
              </span>
              <button disabled={state !== 'ready'} onClick={() => setDevices(!devices)}>
                {devices ? 'Workspace' : 'Devices'}
              </button>
            </header>
            {state === 'pairing' && client.pendingDevice && (
              <section className="remote-account">
                <p>Approve this exact browser on the host or an already paired device.</p>
                <code className="break-all">{client.pendingDevice.peer}</code>
                <pre>{`puddle remote approve ${client.pendingDevice.id}`}</pre>
              </section>
            )}
            {admitted && (
              <div className="remote-workspace" hidden={devices}>
                <PhoneWorkspace connected={state === 'ready' && !devices} />
              </div>
            )}
            {devices && <DeviceAccess client={client} leave={leave} />}
          </div>
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
