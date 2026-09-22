import { useEffect, useState } from 'react';
import type { RemoteDevice } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Disclosure } from '../../components/ui/disclosure';
import { QrCode } from '../../components/ui/qr-code';
import type { RemoteClient } from './client';
import { forgetBrowserHost } from './identity-store';
import { BrowserCards } from './BrowserCards';

export function DeviceAccess({ client, leave }: { client: RemoteClient; leave(): void }) {
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const result = await client.admin({ t: 'devices' });
    if (result.error) throw new Error(result.error);
    setDevices((result.devices ?? []).filter((device) => device.status !== 'revoked'));
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Device update failed');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void action(refresh);
  }, [client]);
  return (
    <section className="grid gap-4 text-sm">
      <p>
        Approval grants terminal control of this host. Compare the browser identity with the device
        requesting access.
      </p>
      <BrowserCards
        devices={devices}
        now={Date.now()}
        currentDevice={client.deviceId ?? undefined}
        busy={busy}
        approve={(id) =>
          void action(async () => {
            const result = await client.admin({ t: 'approve', id });
            if (result.error) throw new Error(result.error);
            await refresh();
          })
        }
        revoke={(id) =>
          void action(async () => {
            const result = await client.admin({ t: 'revoke', id });
            if (result.error) throw new Error(result.error);
            if (id === client.deviceId) leave();
            else await refresh();
          })
        }
      />
      <Button variant="ghost" disabled={busy} onClick={() => void action(refresh)}>
        Refresh devices
      </Button>
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() =>
          void action(async () => {
            const result = await client.admin({ t: 'pair' });
            if (!result.url) throw new Error(result.error ?? 'Could not create invitation');
            setUrl(result.url);
          })
        }
      >
        Pair another browser
      </Button>
      {url && (
        <section>
          <p>
            Open this link on the new browser within five minutes, then return here to approve its
            identity.
          </p>
          <QrCode value={url} label="Pairing invitation QR code" />
          <Button
            variant="ghost"
            onClick={() => void action(() => navigator.clipboard.writeText(url))}
          >
            Copy pairing link
          </Button>
          <a className="pairing-link break-all hover:opacity-80" href={url}>
            Pairing link
          </a>
        </section>
      )}
      <Disclosure summary="Host access">
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              // Deleting a local key never impersonates successful host revocation.
              await forgetBrowserHost(client.host);
              leave();
            })
          }
        >
          Forget this browser’s local pairing
        </Button>
        <p>Forgetting removes the key here. Revoke the browser on the host to end its authority.</p>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const result = await client.admin({ t: 'disable' });
              if (result.error) throw new Error(result.error);
              leave();
            })
          }
        >
          Disable remote access on this host
        </Button>
      </Disclosure>
      <p role="status" className="text-xs text-danger">
        {message}
      </p>
    </section>
  );
}
