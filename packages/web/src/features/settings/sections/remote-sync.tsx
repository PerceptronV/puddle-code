import { RemoteAccessSection } from '../remote-access/RemoteAccessSection';
import { SyncSection } from './sync';

export function RemoteSyncSection() {
  return (
    <div className="space-y-8">
      <RemoteAccessSection />
      <SyncSection />
    </div>
  );
}
