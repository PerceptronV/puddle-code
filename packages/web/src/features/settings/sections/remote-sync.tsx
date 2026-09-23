import { useCurrentProfileId } from '../../profile/profile-store';
import { RemoteAccessSection } from '../remote-access/RemoteAccessSection';
import { SyncSection } from './sync';

export function RemoteSyncSection() {
  const profile = useCurrentProfileId();
  return (
    <div className="space-y-8">
      <RemoteAccessSection key={profile} />
      <SyncSection />
    </div>
  );
}
