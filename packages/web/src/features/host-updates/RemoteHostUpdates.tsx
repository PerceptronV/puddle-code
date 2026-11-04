import { useCallback, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { useHostUpdateAccess } from './queries';
import { HostUpdatesSection } from './HostUpdatesSection';
import { HostUpdateToast } from './HostUpdateToast';

/** Remote windows reuse the same exact review/apply UI inside their host shell. */
export function RemoteHostUpdates({ hostName }: { hostName: string }) {
  const allowed = useHostUpdateAccess();
  const [open, setOpen] = useState(false);
  const review = useCallback(() => setOpen(true), []);
  if (!allowed) return null;
  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Host updates" onClick={review}>
        <Download />
      </Button>
      <HostUpdateToast onReview={review} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Host updates</DialogTitle>
            <DialogDescription>{hostName}</DialogDescription>
          </DialogHeader>
          <HostUpdatesSection />
        </DialogContent>
      </Dialog>
    </>
  );
}
