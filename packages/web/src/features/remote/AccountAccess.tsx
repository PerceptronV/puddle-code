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
  const resetToken = new URLSearchParams(location.search).get('token');
  const [mode, setMode] = useState<'signin' | 'signup' | 'recover' | 'reset'>(
    resetToken ? 'reset' : 'signin',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
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
  const submit = () =>
    action(async () => {
      if (mfa || needsMfa) {
        authResult(
          backup
            ? await authClient.twoFactor.verifyBackupCode({ code })
            : await authClient.twoFactor.verifyTotp({ code }),
        );
        setCode('');
        await refresh();
      } else if (mode === 'signup') {
        authResult(
          await authClient.signUp.email({ email, password, name, callbackURL: location.origin }),
        );
        setMessage('Check your email to verify your account, then sign in.');
        setMode('signin');
      } else if (mode === 'recover') {
        authResult(
          await authClient.requestPasswordReset({
            email,
            redirectTo: `${location.origin}/reset-password`,
          }),
        );
        setMessage('If the account exists, a recovery link has been sent.');
      } else if (mode === 'reset') {
        authResult(
          await authClient.resetPassword({ newPassword: password, token: resetToken ?? '' }),
        );
        history.replaceState(null, '', '/');
        setMode('signin');
        setMessage('Password reset. Sign in to continue.');
      } else {
        const result = authResult(
          await authClient.signIn.email({ email, password, callbackURL: location.origin }),
        );
        if (result && 'twoFactorRedirect' in result && result.twoFactorRedirect) setNeedsMfa(true);
        await refresh();
      }
    });
  return (
    <main className="remote-account">
      <h1>Puddle</h1>
      <p>Connect to your own machines.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mfa || needsMfa ? (
          <>
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
          </>
        ) : (
          <>
            {mode === 'signup' && (
              <label>
                Name
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </label>
            )}
            {mode !== 'reset' && (
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
            )}
            {mode !== 'recover' && (
              <label>
                Password
                <input
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            )}
          </>
        )}
        <button disabled={busy} type="submit">
          {busy
            ? 'Please wait…'
            : mfa || needsMfa
              ? 'Verify'
              : mode === 'signup'
                ? 'Create account'
                : mode === 'recover'
                  ? 'Send recovery link'
                  : mode === 'reset'
                    ? 'Save password'
                    : 'Sign in'}
        </button>
      </form>
      {!mfa && !needsMfa && (
        <>
          {providers.map((provider) => (
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
          ))}
          <nav>
            <button onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}>
              {mode === 'signup' ? 'Sign in' : 'Create account'}
            </button>
            <button onClick={() => setMode('recover')}>Forgot password</button>
          </nav>
        </>
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
  const [password, setPassword] = useState('');
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
      <label>
        Current password (leave empty for a social-only account)
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {!setup && (
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              if (enabled) {
                authResult(
                  await authClient.twoFactor.disable({ ...(password ? { password } : {}) }),
                );
                await refresh();
              } else {
                const data = authResult(
                  await authClient.twoFactor.enable({ ...(password ? { password } : {}) }),
                );
                if (data?.method === 'totp') setSetup(data);
              }
              setPassword('');
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
