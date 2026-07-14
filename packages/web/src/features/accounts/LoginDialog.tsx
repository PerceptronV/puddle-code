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
  onClose,
}: {
  stream: string;
  label: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide className="h-[28rem]">
        <DialogHeader>
          <DialogTitle className="font-mono">{label} — login</DialogTitle>
          <DialogDescription>
            Complete the agent&apos;s login flow below. The account shows as logged in once it
            finishes cleanly.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md bg-ground p-1">
          <LazyTerminal stream={stream} onExit={onClose} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
