import { useState } from 'react';
import { authClient, authResult } from './service';

export function AccountAccess({
  providers,
  mfa,
  refresh,
}: {
  providers: Array<'google' | 'github'>;
  mfa: boolean;
  refresh(): Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(() =>
    new URLSearchParams(location.search).has('error')
      ? 'Sign-in failed. Use your original provider with a verified email address.'
      : '',
  );
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="remote-account">
      <h1>Puddle</h1>
      <p>Connect to your own machines.</p>
      {mfa ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              authResult(
                backup
                  ? await authClient.twoFactor.verifyBackupCode({ code })
                  : await authClient.twoFactor.verifyTotp({ code }),
              );
              setCode('');
              await refresh();
            });
          }}
        >
          <label>
            {backup ? 'Recovery code' : 'Authenticator code'}
            <input
              autoComplete="one-time-code"
              inputMode={backup ? 'text' : 'numeric'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
          <button type="button" onClick={() => setBackup(!backup)}>
            {backup ? 'Use authenticator' : 'Use recovery code'}
          </button>
          <button disabled={busy} type="submit">
            {busy ? 'Please wait…' : 'Verify'}
          </button>
        </form>
      ) : (
        providers.map((provider) => (
          <button
            key={provider}
            disabled={busy}
            onClick={() =>
              void action(async () => {
                authResult(
                  await authClient.signIn.social({ provider, callbackURL: location.origin }),
                );
              })
            }
          >
            Continue with {provider === 'github' ? 'GitHub' : 'Google'}
          </button>
        ))
      )}
      <p role="status">{message}</p>
    </main>
  );
}

export function AccountSecurity({
  enabled,
  refresh,
}: {
  enabled: boolean;
  refresh(): Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Account update failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h2>Account security</h2>
      <p>
        Two-factor authentication: {enabled ? 'enabled' : 'off'}. Account recovery does not replace
        host pairing.
      </p>
      {!setup && (
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              if (enabled) {
                authResult(await authClient.twoFactor.disable({}));
                await refresh();
              } else {
                const data = authResult(await authClient.twoFactor.enable({}));
                if (data?.method === 'totp') setSetup(data);
              }
            })
          }
        >
          {enabled ? 'Disable two-factor authentication' : 'Set up authenticator'}
        </button>
      )}
      {setup && (
        <>
          <p>Add this account to your authenticator. Save the recovery codes somewhere private.</p>
          <a href={setup.totpURI}>Open authenticator</a>
          <p className="break-all select-all">{setup.totpURI}</p>
          <pre>{setup.backupCodes.join('\n')}</pre>
          <label>
            Authenticator code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                authResult(await authClient.twoFactor.verifyTotp({ code }));
                setSetup(null);
                setCode('');
                await refresh();
              })
            }
          >
            Verify and finish
          </button>
        </>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
