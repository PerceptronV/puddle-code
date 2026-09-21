import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button } from '../../../components/ui/button';

/** Invitation secrets stay in mounted component state and disappear at expiry. */
export function PairingInvitation({
  url,
  expires,
  dismiss,
}: {
  url: string;
  expires: number;
  dismiss(): void;
}) {
  const [qr, setQr] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let current = true;
    void QRCode.toDataURL(url, { width: 240 })
      .then((data) => {
        if (current) setQr(data);
      })
      .catch(() => {
        if (current) setMessage('QR code unavailable. Use the pairing link.');
      });
    const expiry = setTimeout(dismiss, Math.max(0, expires - Date.now()));
    return () => {
      current = false;
      clearTimeout(expiry);
    };
  }, [url, expires, dismiss]);
  return (
    <section className="mt-5 space-y-3" aria-label="Pairing invitation">
      <p className="text-sm text-fg-secondary">
        Scan or open this link on the new browser, then approve its exact identity below. Expires{' '}
        {new Date(expires).toLocaleTimeString()}.
      </p>
      {qr && <img src={qr} width={240} height={240} alt="Pairing invitation QR code" />}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard
              .writeText(url)
              .then(() => setMessage('Pairing link copied.'))
              .catch(() =>
                setMessage('Could not copy. Open the pairing link or scan the QR code.'),
              );
          }}
        >
          Copy pairing link
        </Button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="px-2 text-sm text-accent hover:opacity-80"
        >
          Open pairing link ↗
        </a>
        <Button variant="ghost" onClick={dismiss}>
          Hide invitation
        </Button>
      </div>
      {message && (
        <p className="text-xs text-fg-muted" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
