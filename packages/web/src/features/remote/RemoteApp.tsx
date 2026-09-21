import { useEffect, useState } from 'react';
import {
  remoteHostsSchema,
  remoteInvitationSchema,
  remoteLoginStateSchema,
  remoteServiceInfoSchema,
  registrationResponseSchema,
  type RemoteHost,
  type RemoteInvitation,
} from '@puddle/shared';
import { createIdentity } from '@puddle/remote-transport';
import { AccountAccess, AccountSecurity } from './AccountAccess';
import { authClient, authResult, serviceOrigin, serviceRequest } from './service';
import { loadBrowserHost, saveBrowserHost, forgetBrowserHost } from './identity-store';
import { RemoteClient } from './client';
import { ConnectedHost } from './ConnectedHost';
import { Disclosure } from '../../components/ui/disclosure';
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
  const [desktopRegistration, setDesktopRegistration] = useState(initialRegistration.request);
  const [invitation, setInvitation] = useState(initialInvitation);
  const [label, setLabel] = useState('');
  const [registration, setRegistration] = useState<ReturnType<
    typeof registrationResponseSchema.parse
  > | null>(null);
  const [message, setMessage] = useState(initialRegistration.error);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const state = remoteLoginStateSchema.parse(await serviceRequest('/remote/me'));
    setLogin(state);
    if (state.user?.emailVerified && !state.mfaRequired)
      setHosts(remoteHostsSchema.parse(await serviceRequest('/remote/hosts')));
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
  const connect = async (host: string, pairing?: RemoteInvitation) => {
    if (!login?.user) return;
    let identity = await loadBrowserHost(serviceOrigin, login.user.id, host);
    if (pairing && identity && identity.peer !== pairing.peer)
      throw new Error(
        'The host identity has changed. Forget the old pairing in this browser before accepting its replacement.',
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
    const next = new RemoteClient(identity, pairing?.invitation);
    client?.close();
    setClient(next);
    if (pairing) {
      sessionStorage.removeItem('puddle.pending-pair');
      setInvitation(null);
    }
  };
  if (!login)
    return (
      <main className="remote-account">
        <h1>Puddle</h1>
        <p role="status">{message || 'Connecting…'}</p>
      </main>
    );
  if (!login.user || login.mfaRequired)
    return (
      <div className="remote-ui">
        <AccountAccess providers={providers} mfa={login.mfaRequired} refresh={refresh} />
      </div>
    );
  if (client)
    return (
      <div className="remote-ui">
        <ConnectedHost
          key={client.scope}
          client={client}
          leave={() => {
            client.close();
            setClient(null);
          }}
        />
      </div>
    );
  return (
    <main className="remote-ui remote-account">
      <header>
        <h1>Puddle</h1>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              authResult(await authClient.signOut());
              setRegistration(null);
              await refresh();
            })
          }
        >
          Sign out
        </button>
      </header>
      <p>{login.user.email}</p>
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
        <section>
          <h2>Pair this browser</h2>
          <p>Host identity</p>
          <code className="break-all">{invitation.peer}</code>
          <label>
            Browser name
            <input
              value={label}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Phone"
            />
          </label>
          <button
            disabled={busy}
            onClick={() => void action(() => connect(invitation.host, invitation))}
          >
            Request host approval
          </button>
        </section>
      )}
      <section>
        <h2>Your hosts</h2>
        {hosts.length === 0 && <p>No registered hosts yet.</p>}
        {hosts.map((host) => (
          <div key={host.id} className="remote-host-row">
            <button
              disabled={busy || !host.online}
              onClick={() => void action(() => connect(host.id))}
            >
              {host.label} · {host.online ? 'Connect' : 'Offline'}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const saved = await loadBrowserHost(serviceOrigin, login.user!.id, host.id);
                  if (saved) await forgetBrowserHost(saved);
                  setMessage(
                    'Local key removed. Revoke its device record on the host to end its authority.',
                  );
                })
              }
            >
              Forget pairing
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await serviceRequest(`/remote/hosts/${host.id}`, 'DELETE');
                  await refresh();
                })
              }
            >
              Unregister
            </button>
          </div>
        ))}
        <button onClick={() => void action(refresh)}>Refresh hosts</button>
      </section>
      <Disclosure summary="Add a host">
        <label>
          Host name
          <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <button
          disabled={busy || !label.trim()}
          onClick={() =>
            void action(async () => {
              setRegistration(
                registrationResponseSchema.parse(
                  await serviceRequest('/remote/hosts', 'POST', { label }),
                ),
              );
              await refresh();
            })
          }
        >
          Create registration code
        </button>
        {registration && (
          <>
            <p>On the machine running Puddle, or through SSH, run:</p>
            <pre>{`puddle remote enable --service ${serviceOrigin} --app-origin ${location.origin}`}</pre>
            <p>Paste this code when prompted. It expires in five minutes.</p>
            <code className="break-all select-all">{registration.code}</code>
            <p>
              Then run <code>puddle remote pair</code> and open its link in this browser.
            </p>
          </>
        )}
      </Disclosure>
      <Disclosure summary="Account security">
        <AccountSecurity enabled={login.user.twoFactorEnabled} refresh={refresh} />
      </Disclosure>
      <p role="status">{message}</p>
    </main>
  );
}
