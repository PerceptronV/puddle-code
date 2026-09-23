import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../../../components/ui/dialog';

export function DeleteRegistrationDialog({
  open,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      <DialogContent>
        <DialogTitle>Delete this profile’s remote registration?</DialogTitle>
        <DialogDescription>
          Disable remote access, remove the saved registration for this profile and revoke its
          browser approval and invitation. Agents keep running. Connecting again requires a new
          registration code and fresh browser approvals.
        </DialogDescription>
        <p className="text-sm text-fg-secondary">
          This also removes this registration from its account’s remote host list. If the service is
          unavailable, removal finishes when it reconnects.
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {busy ? 'Deleting…' : 'Delete registration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
