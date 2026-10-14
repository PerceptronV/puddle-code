import { useEffect, useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import type { RemoteInvitation } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Label } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { parsePairingLink } from './pairing-invitation';
import { scanQrCamera } from './qr-camera';
import { serviceOrigin } from './service';

export function PairDeviceDialog({
  dismiss,
  accept,
}: {
  dismiss(): void;
  accept(invitation: RemoteInvitation): void;
}) {
  const [scanning, setScanning] = useState(false);
  const [link, setLink] = useState('');
  const [message, setMessage] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const read = (text: string) => {
    try {
      const invitation = parsePairingLink(text, location.origin, serviceOrigin);
      acceptRef.current(invitation);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not read the pairing link.');
    }
  };
  useEffect(() => {
    if (!scanning || !video.current) return;
    return scanQrCamera(
      video.current,
      (text) => {
        setScanning(false);
        read(text);
      },
      (message) => {
        setScanning(false);
        setMessage(message);
      },
    );
  }, [scanning]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent className="grid-cols-1 [overflow-wrap:anywhere] [&>*]:min-w-0">
        <DialogHeader className="pr-6">
          <DialogTitle>Pair this device</DialogTitle>
          <DialogDescription>
            On desktop, open Settings → Remote &amp; Sync → Pair a browser. Scan that QR code here,
            then approve this device on your host.
          </DialogDescription>
        </DialogHeader>
        {scanning && (
          <>
            <video
              ref={video}
              autoPlay
              playsInline
              muted
              aria-label="Pairing QR camera"
              className="aspect-[4/3] max-h-[40dvh] w-full rounded-md bg-surface object-contain"
            />
            <p role="status" className="text-sm text-fg-muted">
              Point the camera at the pairing QR code.
            </p>
          </>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            setMessage('');
            setScanning(!scanning);
          }}
        >
          <ScanLine />
          {scanning ? 'Stop camera' : 'Scan QR code'}
        </Button>
        <form
          className="grid min-w-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setScanning(false);
            setMessage('');
            read(link);
          }}
        >
          <Label htmlFor="pairing-link">Or paste a pairing link</Label>
          <Input
            id="pairing-link"
            type="text"
            value={link}
            maxLength={8192}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setLink(event.target.value)}
          />
          <Button type="submit" variant="ghost" disabled={!link.trim()}>
            Continue
          </Button>
        </form>
        {message && (
          <p role="alert" className="text-sm text-danger">
            {message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
