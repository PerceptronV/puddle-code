import { useEffect, useState } from 'react';
import {
  remoteHostsSchema,
  remoteInvitationSchema,
  remoteLoginStateSchema,
  remoteServiceInfoSchema,
  type RemoteHost,
  type RemoteInvitation,
} from '@puddle/shared';
import { createIdentity } from '@puddle/remote-transport';
import { AccountAccess } from './AccountAccess';
import { FaqLink } from '../faq/FaqLink';
import { serviceOrigin, serviceRequest } from './service';
import { loadBrowserHost, saveBrowserHost } from './identity-store';
import { RemoteClient } from './client';
import { ConnectedHost } from './ConnectedHost';
import { Settings2, Laptop } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { TooltipProvider } from '../../components/ui/tooltip';
import { Toaster } from '../../components/ui/sonner';
import { ErrorBoundary } from '../../components/error-boundary';
import { usePhoneViewport } from '../mobile/use-phone-viewport';
import { HostProjects } from './HostProjects';
import { RemoteSettings } from './RemoteSettings';
import { RemoteBrand } from './RemoteBrand';
import { PairBrowserDialog } from './PairBrowserDialog';
import { DesktopRegistrationPrompt, takeDesktopRegistration } from './DesktopRegistration';
import './remote.css';

// Strip invitations before rendering, fetching or loading any repository content.
function takeInvitation(): RemoteInvitation | null {
  const fragment = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (fragment !== null) history.replaceState(null, '', location.pathname);
  try {
    const raw = fragment ?? sessionStorage.getItem('puddle.pending-pair');
    if (!raw) return null;
    const invitation = remoteInvitationSchema.parse(JSON.parse(raw));
    if (invitation.service !== serviceOrigin || invitation.expires <= Date.now())
      throw new Error('Expired invitation');
    // Survives the provider redirect in this tab only. Never a durable login credential.
    sessionStorage.setItem('puddle.pending-pair', raw);
    return invitation;
  } catch {
    sessionStorage.removeItem('puddle.pending-pair');
    return null;
  }
}
const initialRegistration = takeDesktopRegistration();
const initialInvitation = takeInvitation();

export function RemoteApp() {
  const [login, setLogin] = useState<ReturnType<typeof remoteLoginStateSchema.parse> | null>(null);
  const [providers, setProviders] = useState<Array<'google' | 'github'>>([]);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [client, setClient] = useState<RemoteClient | null>(null);
  const [projectId, setProjectId] = useState('');
  const [settings, setSettings] = useState(false);
  const [disconnected, setDisconnected] = useState<Set<string>>(new Set());
  const [desktopRegistration, setDesktopRegistration] = useState(initialRegistration.request);
  const [invitation, setInvitation] = useState(initialInvitation);
  const [message, setMessage] = useState(initialRegistration.error);
  const [busy, setBusy] = useState(false);
  usePhoneViewport();
  const refresh = async () => {
    const state = remoteLoginStateSchema.parse(await serviceRequest('/remote/me'));
    setLogin(state);
    if (state.user?.emailVerified && !state.mfaRequired)
      setHosts(remoteHostsSchema.parse(await serviceRequest('/remote/hosts')));
    else setHosts([]);
  };
  useEffect(() => {
    void Promise.all([
      refresh(),
      serviceRequest('/remote/config').then((value) =>
        setProviders(remoteServiceInfoSchema.parse(value).providers),
      ),
    ]).catch(() => setMessage('Could not reach the remote service. Reload to try again.'));
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (login && (!login.user || login.mfaRequired)) {
      client?.close();
      setClient(null);
      setDisconnected(new Set());
    }
  }, [login, client]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operation failed');
    } finally {
      setBusy(false);
    }
  };
  const connect = async (host: string, project = '', pairing?: RemoteInvitation, label = '') => {
    if (!login?.user) return;
    let identity = await loadBrowserHost(serviceOrigin, login.user.id, host);
    if (pairing && identity && identity.peer !== pairing.peer)
      throw new Error(
        'The host identity has changed. Forget the old pairing in settings before accepting its replacement.',
      );
    if (!identity) {
      if (!pairing)
        throw new Error(
          'Pair this browser using a link from the host or an already paired browser.',
        );
      if (!label.trim()) throw new Error('Enter a name for this browser.');
      identity = {
        host,
        service: serviceOrigin,
        account: login.user.id,
        peer: pairing.peer,
        label: label.trim(),
        privateKey: [...(await createIdentity())],
      };
      await saveBrowserHost(identity);
    }
    client?.close();
    setProjectId(project);
    setClient(new RemoteClient(identity, pairing?.invitation));
    setDisconnected((current) => {
      const next = new Set(current);
      next.delete(host);
      return next;
    });
    if (pairing) {
      sessionStorage.removeItem('puddle.pending-pair');
      setInvitation(null);
    }
  };
  const leave = () => {
    client?.close();
    setClient(null);
  };
  return (
    <TooltipProvider>
      <Toaster />
      <ErrorBoundary scope="remote app">
        {!login ? (
          <main className="remote-account">
            <RemoteBrand />
            <p role="status" className="mt-4 text-sm text-fg-muted">
              {message || 'Connecting…'}
            </p>
          </main>
        ) : !login.user || login.mfaRequired ? (
          <AccountAccess providers={providers} mfa={login.mfaRequired} refresh={refresh} />
        ) : (
          <div className="remote-ui">
            {client ? (
              <ConnectedHost
                key={client.scope}
                client={client}
                initialProject={projectId}
                hostName={hosts.find((host) => host.id === client.host.host)?.label ?? 'Host'}
                leave={leave}
                settings={() => setSettings(true)}
              />
            ) : (
              <main className="remote-dashboard" aria-label="Hosts and projects">
                <header className="mb-3 flex items-center justify-between">
                  <RemoteBrand />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Settings"
                    onClick={() => setSettings(true)}
                  >
                    <Settings2 />
                  </Button>
                </header>
                <FaqLink className="mb-4" />
                {hosts.map((host) => (
                  <HostProjects
                    key={`${login.user!.id}:${host.id}`}
                    host={host}
                    account={login.user!.id}
                    disconnected={disconnected.has(host.id)}
                    reconnect={() =>
                      setDisconnected((current) => {
                        const next = new Set(current);
                        next.delete(host.id);
                        return next;
                      })
                    }
                    open={(project) => void action(() => connect(host.id, project.id))}
                  />
                ))}
                {hosts.length === 0 && (
                  <div className="py-12 text-center">
                    <Laptop className="mx-auto mb-4 size-8 text-fg-muted" />
                    <p className="text-sm text-fg-secondary">
                      Connect your first host to see its projects here.
                    </p>
                    <Button className="mt-4" variant="secondary" onClick={() => setSettings(true)}>
                      Add a host
                    </Button>
                  </div>
                )}
                {message && !invitation && (
                  <p role="status" className="mt-4 text-sm text-fg-secondary">
                    {message}
                  </p>
                )}
              </main>
            )}
            <RemoteSettings
              open={settings}
              onOpenChange={setSettings}
              hosts={hosts}
              account={login.user.id}
              email={login.user.email}
              mfa={login.user.twoFactorEnabled}
              disconnected={disconnected}
              disconnect={(id) => {
                setDisconnected((current) => new Set([...current, id]));
                if (client?.host.host === id) leave();
              }}
              reconnect={(id) =>
                setDisconnected((current) => {
                  const next = new Set(current);
                  next.delete(id);
                  return next;
                })
              }
              refresh={refresh}
            />
            {desktopRegistration && (
              <DesktopRegistrationPrompt
                request={desktopRegistration}
                dismiss={() => setDesktopRegistration(null)}
                complete={async () => {
                  setMessage('Host confirmed. Return to desktop to finish enabling remote access.');
                  await refresh();
                }}
              />
            )}
            {invitation && (
              <PairBrowserDialog
                invitation={invitation}
                hostName={hosts.find((host) => host.id === invitation.host)?.label}
                busy={busy}
                error={message}
                dismiss={() => {
                  setInvitation(null);
                  setMessage('');
                  sessionStorage.removeItem('puddle.pending-pair');
                }}
                pair={(label) => void action(() => connect(invitation.host, '', invitation, label))}
              />
            )}
          </div>
        )}
      </ErrorBoundary>
    </TooltipProvider>
  );
}
