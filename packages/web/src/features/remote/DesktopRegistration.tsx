import { useEffect, useState } from 'react';
import { desktopRegistrationSchema, REMOTE_POLICY, type DesktopRegistration } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { serviceOrigin, serviceRequest } from './service';

const storageKey = 'puddle.pending-registration';

// Strip the public handoff before OAuth or any network request. Only its hash survives
// the provider redirect in this tab; the redeeming secret never leaves the cockpit.
export function takeDesktopRegistration(): { request: DesktopRegistration | null; error: string } {
  const fragment = new URLSearchParams(location.hash.slice(1)).get('register');
  if (fragment !== null) history.replaceState(null, '', location.pathname);
  try {
    const raw = fragment ?? sessionStorage.getItem(storageKey);
    if (!raw) return { request: null, error: '' };
    if (raw.length > 2048) throw new Error('Invalid registration');
    const request = desktopRegistrationSchema.parse(JSON.parse(raw));
    if (
      request.service !== serviceOrigin ||
      request.app !== location.origin ||
      request.expires <= Date.now() ||
      request.expires > Date.now() + REMOTE_POLICY.invitationMs
    )
      throw new Error('Invalid registration');
    sessionStorage.setItem(storageKey, raw);
    return { request, error: '' };
  } catch {
    sessionStorage.removeItem(storageKey);
    return {
      request: null,
      error: 'This desktop sign-in request is invalid or expired. Start again in desktop.',
    };
  }
}

export function DesktopRegistrationPrompt({
  request,
  dismiss,
  complete,
}: {
  request: DesktopRegistration;
  dismiss(): void;
  complete(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(request.expires <= Date.now());
  useEffect(() => {
    const timer = setTimeout(
      () => {
        sessionStorage.removeItem(storageKey);
        setExpired(true);
      },
      Math.max(0, request.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [request]);
  const clear = () => {
    sessionStorage.removeItem(storageKey);
    dismiss();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) clear();
      }}
    >
      <DialogContent aria-label="Desktop registration">
        <DialogHeader>
          <DialogTitle>Connect {request.label}</DialogTitle>
          <DialogDescription>
            Confirm that request{' '}
            <strong className="font-mono">{request.challenge.slice(0, 8).toUpperCase()}</strong>{' '}
            matches the Puddle desktop window you just opened. This adds the host to your signed-in
            account.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-fg-muted">
          Browser access still requires pairing and approval on the host.
        </p>
        {expired && <p role="alert">Sign-in expired. Start again in desktop.</p>}
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <Button
            disabled={busy || expired}
            onClick={() => {
              setBusy(true);
              setError('');
              void serviceRequest('/remote/desktop-registration', 'POST', request)
                .then(async () => {
                  clear();
                  await complete();
                })
                .catch(() =>
                  setError(
                    'Could not confirm this request. It may have expired or already been approved. Start again in desktop.',
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Connecting…' : 'Confirm host'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={clear}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
