import { useParams } from 'react-router';
import { useProjectDetail } from '../../lib/queries';

/** Project workspace — sidebar, terminals, and modals land in workstream D. */
export function Workspace() {
  const params = useParams();
  const projectId = Number(params['id']);
  const detail = useProjectDetail(Number.isInteger(projectId) ? projectId : undefined);

  return (
    <div className="p-6">
      <h1 className="font-mono text-lg font-semibold text-fg">
        {detail.data?.project.name ?? '…'}
      </h1>
      <p className="mt-2 text-sm text-fg-muted">The workspace fills in with workstream D.</p>
    </div>
  );
}
