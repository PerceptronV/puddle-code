import { pushEnabled, setPushEnabled, testPushNotifications } from './push-notifications';
import { Switch } from '../../components/ui/switch';
import { useState } from 'react';
import { LogOut, Laptop, Trash2, Unplug } from 'lucide-react';
import { registrationResponseSchema, type RemoteHost } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Disclosure } from '../../components/ui/disclosure';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { applyTheme, storedPreference, type ThemePreference } from '../../lib/theme';
import { AccountSecurity } from './AccountAccess';
import { authClient, authResult, serviceOrigin, serviceRequest } from './service';
import { forgetBrowserHost, loadBrowserHost } from './identity-store';

export function RemoteSettings({
  open,
  onOpenChange,
  hosts,
  account,
  email,
  mfa,
  disconnected,
  disconnect,
  reconnect,
  refresh,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  hosts: RemoteHost[];
  account: string;
  email: string;
  mfa: boolean;
  disconnected: ReadonlySet<string>;
  disconnect(id: string): void;
  reconnect(id: string): void;
  refresh(): Promise<void>;
}) {
  const [notifications, setNotifications] = useState(() => pushEnabled(account));
  const [theme, setTheme] = useState(storedPreference);
  const [label, setLabel] = useState('');
  const [registration, setRegistration] = useState<ReturnType<
    typeof registrationResponseSchema.parse
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [notificationMessage, setNotificationMessage] = useState('');
  const [testingNotifications, setTestingNotifications] = useState(false);
  const [removing, setRemoving] = useState<RemoteHost | null>(null);
  const action = async (fn: () => Promise<void>, report = setMessage) => {
    setBusy(true);
    setMessage('');
    setNotificationMessage('');
    try {
      await fn();
    } catch (error) {
      report(error instanceof Error ? error.message : 'Could not update settings.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-1 gap-6 [overflow-wrap:anywhere] [&>*]:min-w-0">
        <DialogHeader className="pr-6">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>{email}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="remote-theme">Appearance</Label>
          <Select
            value={theme}
            onValueChange={(value) => {
              const next = value as ThemePreference;
              applyTheme(next);
              setTheme(next);
            }}
          >
            <SelectTrigger id="remote-theme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <section className="grid grid-cols-1 gap-3" aria-label="Notifications">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="remote-notifications">Background notifications on this device</Label>
            <Switch
              id="remote-notifications"
              checked={notifications}
              disabled={busy}
              onCheckedChange={(enabled) => {
                void action(async () => {
                  setNotificationMessage(await setPushEnabled(account, enabled));
                  setNotifications(pushEnabled(account));
                }, setNotificationMessage);
              }}
            />
          </div>
          <p className="text-xs text-fg-muted">
            Receive generic agent alerts from your paired hosts, while this app is open or closed.
            On iPhone or iPad, open Puddle from the Home Screen first. Host notification preferences
            and project mutes still apply.
          </p>
          <Button
            variant="ghost"
            disabled={busy || !notifications}
            onClick={() => {
              setTestingNotifications(true);
              void action(
                async () =>
                  setNotificationMessage(
                    await testPushNotifications(account, setNotificationMessage),
                  ),
                setNotificationMessage,
              ).finally(() => setTestingNotifications(false));
            }}
          >
            {testingNotifications ? 'Sending…' : 'Send test'}
          </Button>
          {notificationMessage && (
            <p role="status" className="text-xs text-fg-secondary">
              {notificationMessage}
            </p>
          )}
        </section>
        <section className="grid grid-cols-1 gap-3" aria-label="Host connections">
          <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Hosts</h3>
          {hosts.map((host) => (
            <div key={host.id} className="flex items-center gap-3">
              <Laptop className="size-4 shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{host.label}</p>
                <p className="text-xs text-fg-muted">
                  {disconnected.has(host.id) ? 'Disconnected' : host.online ? 'Online' : 'Offline'}
                </p>
              </div>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  disconnected.has(host.id) ? reconnect(host.id) : disconnect(host.id)
                }
              >
                <Unplug />
                {disconnected.has(host.id) ? 'Connect' : 'Disconnect'}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={`Remove ${host.label}`}
                title="Remove host registration"
                onClick={() => {
                  setMessage('');
                  setRemoving(host);
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {hosts.length === 0 && <p className="text-sm text-fg-muted">No hosts connected yet.</p>}
        </section>
        <Disclosure summary="Add a host">
          <form
            className="mt-3 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void action(async () => {
                setRegistration(
                  registrationResponseSchema.parse(
                    await serviceRequest('/remote/hosts', 'POST', { label: label.trim() }),
                  ),
                );
                await refresh();
              });
            }}
          >
            <Label htmlFor="host-name">Host name</Label>
            <Input
              id="host-name"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
              required
            />
            <Button
              className="h-auto min-h-8 whitespace-normal py-1.5"
              disabled={busy || !label.trim()}
              type="submit"
            >
              Create registration code
            </Button>
          </form>
          {registration && (
            <div className="mt-3 space-y-3 text-sm text-fg-secondary">
              <p>On your host, run:</p>
              <pre className="whitespace-pre-wrap break-all text-xs">{`puddle remote enable --service ${serviceOrigin} --app-origin ${location.origin}`}</pre>
              <p>Paste this code within five minutes:</p>
              <code className="block break-all select-all">{registration.code}</code>
              <p>
                Then open the link from <code>puddle remote pair</code> in this browser.
              </p>
            </div>
          )}
        </Disclosure>
        <Disclosure summary="Account security">
          <div className="mt-3">
            <AccountSecurity enabled={mfa} refresh={refresh} />
          </div>
        </Disclosure>
        {hosts.length > 0 && (
          <Disclosure summary="Manage pairings">
            <p className="my-3 text-xs text-fg-muted">
              Forgetting removes this browser’s key. Revoke its device record on the host to end its
              authority.
            </p>
            {hosts.map((host) => (
              <div key={host.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                <span className="text-sm">{host.label}</span>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const identity = await loadBrowserHost(serviceOrigin, account, host.id);
                      if (identity) await forgetBrowserHost(identity);
                      disconnect(host.id);
                      setMessage('Pairing removed from this browser.');
                    })
                  }
                >
                  Forget pairing
                </Button>
              </div>
            ))}
          </Disclosure>
        )}
        <Button
          className="justify-start"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              // Push cleanup must never trap the user in an authenticated account.
              if (pushEnabled(account)) await setPushEnabled(account, false).catch(() => {});
              authResult(await authClient.signOut());
              onOpenChange(false);
              await refresh();
            })
          }
        >
          <LogOut />
          Sign out
        </Button>
        {message && (
          <p role="status" className="text-sm text-fg-secondary">
            {message}
          </p>
        )}
        <Dialog
          open={removing !== null}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
        >
          <DialogContent className="grid-cols-1 [overflow-wrap:anywhere] [&>*]:min-w-0">
            <DialogHeader>
              <DialogTitle>Remove {removing?.label}?</DialogTitle>
              <DialogDescription>
                Remove this host from your account and disconnect its remote viewers. Its agents
                keep running. Register it again from desktop to reconnect.
              </DialogDescription>
            </DialogHeader>
            {message && (
              <p role="alert" className="text-sm text-danger">
                {message}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (!removing) return;
                    await serviceRequest(`/remote/hosts/${removing.id}`, 'DELETE');
                    const identity = await loadBrowserHost(serviceOrigin, account, removing.id);
                    if (identity) await forgetBrowserHost(identity);
                    disconnect(removing.id);
                    setRemoving(null);
                    await refresh();
                  })
                }
              >
                Remove host
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
