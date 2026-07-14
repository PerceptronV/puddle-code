import { useProjects } from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';

/** Project dashboard — full cards land in workstream D. */
export function Dashboard() {
  const profileId = useCurrentProfileId();
  const projects = useProjects(profileId ?? undefined);

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-fg">Projects</h1>
      <p className="mt-2 text-sm text-fg-muted">
        {projects.data?.length ?? 0} project(s) — the dashboard fills in with workstream D.
      </p>
    </div>
  );
}
