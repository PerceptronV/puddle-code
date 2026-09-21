import { useState } from 'react';
import type { RemoteInvitation } from '@puddle/shared';
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

export function PairBrowserDialog({
  invitation,
  hostName,
  busy,
  error,
  dismiss,
  pair,
}: {
  invitation: RemoteInvitation;
  hostName?: string;
  busy: boolean;
  error: string;
  dismiss(): void;
  pair(label: string): void;
}) {
  const [label, setLabel] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) dismiss();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair this browser</DialogTitle>
          <DialogDescription>
            Give this browser a name, then approve it on {hostName ?? 'your host'}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            pair(label.trim());
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="browser-name">Browser name</Label>
            <Input
              id="browser-name"
              autoFocus
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. My phone"
              required
            />
          </div>
          <Disclosure summary="Host identity">
            <code className="block break-all py-2 text-xs text-fg-muted">{invitation.peer}</code>
          </Disclosure>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !label.trim()}>
              {busy ? 'Requesting…' : 'Request host approval'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
