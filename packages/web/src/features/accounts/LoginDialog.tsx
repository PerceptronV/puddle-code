import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { LazyTerminal } from '../terminal/LazyTerminal';

/** In-app login: a terminal dialog attached to the account's login PTY. */
export function LoginDialog({
  stream,
  label,
  hint,
  onClose,
}: {
  stream: string;
  label: string;
  /** Adapter guidance shown after the standing copy (protocol 13.1) — e.g.
      how to leave a TUI that keeps running after sign-in. */
  hint?: string;
  onClose: () => void;
}) {
  // A clean exit means the login finished, so the dialog closes itself. A
  // failure used to close just as fast, hiding whatever the agent printed —
  // now it stays put so the terminal above remains readable.
  const [failedCode, setFailedCode] = useState<number | null>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide className="h-[28rem]">
        <DialogHeader>
          <DialogTitle>{label} — login</DialogTitle>
          <DialogDescription>
            {failedCode === null
              ? `Complete the agent’s login flow below.${hint !== undefined ? ` ${hint}` : ' The account shows as logged in once it finishes cleanly.'}`
              : `The login exited with code ${failedCode} without completing. The output above may say why; close this and try again.`}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md bg-ground p-1">
          <LazyTerminal
            stream={stream}
            onExit={(code) => (code === 0 ? onClose() : setFailedCode(code))}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
