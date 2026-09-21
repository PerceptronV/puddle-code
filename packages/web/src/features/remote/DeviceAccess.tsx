import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { RemoteDevice } from '@puddle/shared';
import type { RemoteClient } from './client';
import { forgetBrowserHost } from './identity-store';

export function DeviceAccess({ client, leave }: { client: RemoteClient; leave(): void }) {
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [url, setUrl] = useState('');
  const [qr, setQr] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const result = await client.admin({ t: 'devices' });
    if (result.error) throw new Error(result.error);
    setDevices(result.devices ?? []);
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
    <section className="remote-account">
      <h2>Paired browsers</h2>
      <p>
        Approval grants terminal control of this host. Compare the browser identity with the device
        requesting access.
      </p>
      {devices.map((device) => (
        <section key={device.id}>
          <h3>
            {device.label} · {device.status}
            {device.id === client.deviceId ? ' · this browser' : ''}
          </h3>
          <code className="break-all">{device.peer}</code>
          <p>Expires {new Date(device.expires).toLocaleString()}</p>
          {device.status === 'pending' && (
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = await client.admin({ t: 'approve', id: device.id });
                  if (result.error) throw new Error(result.error);
                  await refresh();
                })
              }
            >
              Approve this identity
            </button>
          )}
          {device.status !== 'revoked' && (
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await client.admin({ t: 'revoke', id: device.id });
                  await refresh();
                })
              }
            >
              Revoke
            </button>
          )}
        </section>
      ))}
      <button disabled={busy} onClick={() => void action(refresh)}>
        Refresh devices
      </button>
      <button
        disabled={busy}
        onClick={() =>
          void action(async () => {
            const result = await client.admin({ t: 'pair' });
            if (!result.url) throw new Error(result.error ?? 'Could not create invitation');
            setUrl(result.url);
            setQr(await QRCode.toDataURL(result.url, { width: 280 }));
          })
        }
      >
        Pair another browser
      </button>
      {url && (
        <section>
          <p>
            Open this link on the new browser within five minutes, then return here to approve its
            identity.
          </p>
          <img src={qr} alt="Pairing invitation QR code" width={280} height={280} />
          <button onClick={() => void action(() => navigator.clipboard.writeText(url))}>
            Copy pairing link
          </button>
          <a className="break-all" href={url}>
            Pairing link
          </a>
        </section>
      )}
      <button
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
      </button>
      <p>Forgetting removes the key here. Revoke the browser on the host to end its authority.</p>
      <button
        disabled={busy}
        onClick={() =>
          void action(async () => {
            await client.admin({ t: 'disable' });
            leave();
          })
        }
      >
        Disable remote access on this host
      </button>
      <p role="status">{message}</p>
    </section>
  );
}
