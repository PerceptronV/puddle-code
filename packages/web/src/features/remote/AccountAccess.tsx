import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
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
      <h1 className="text-xl font-semibold tracking-tight">Puddle</h1>
      <p className="mb-8 mt-2 text-sm text-fg-muted">Your workspace, wherever you are.</p>
      {mfa ? (
        <form
          className="grid gap-4"
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
          <Label className="grid gap-2">
            {backup ? 'Recovery code' : 'Authenticator code'}
            <Input
              autoComplete="one-time-code"
              inputMode={backup ? 'text' : 'numeric'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </Label>
          <Button variant="ghost" type="button" onClick={() => setBackup(!backup)}>
            {backup ? 'Use authenticator' : 'Use recovery code'}
          </Button>
          <Button disabled={busy} type="submit">
            {busy ? 'Please wait…' : 'Verify'}
          </Button>
        </form>
      ) : (
        providers.map((provider) => (
          <Button
            className="mb-3 w-full"
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
          </Button>
        ))
      )}
      <p role="status" className="mt-3 text-sm text-fg-muted">
        {message}
      </p>
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
    <section className="grid gap-3 text-sm text-fg-secondary">
      <p>
        Two-factor authentication: {enabled ? 'enabled' : 'off'}. Account recovery does not replace
        host pairing.
      </p>
      {!setup && (
        <Button
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
        </Button>
      )}
      {setup && (
        <>
          <p>Add this account to your authenticator. Save the recovery codes somewhere private.</p>
          <a href={setup.totpURI}>Open authenticator</a>
          <p className="break-all select-all">{setup.totpURI}</p>
          <pre className="rounded-md bg-surface p-3 text-xs">{setup.backupCodes.join('\n')}</pre>
          <Label className="grid gap-2">
            Authenticator code
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </Label>
          <Button
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
          </Button>
        </>
      )}
      <p role="status" className="mt-3 text-sm text-fg-muted">
        {message}
      </p>
    </section>
  );
}
