import { sessionTabRef } from '@puddle/shared';
import type { NotificationTarget, ProjectDetail } from '@puddle/shared';
import { desktopBridge } from '../../../lib/desktop';
import { queryClient } from '../../../lib/queries/client';
import { api } from '../../../lib/transport/api';
import { handleProjectCommand } from './project-actions';

/** A host-wide notification can name a project outside the receiving window's fixed profile. */
export async function openNativeNotification(target: NotificationTarget): Promise<boolean> {
  const windows = desktopBridge()?.windows;
  const projects = windows?.projects;
  if (!projects || target.host) return false;
  const detail = await queryClient.fetchQuery({
    queryKey: ['project', target.project],
    queryFn: () => api<ProjectDetail>('GET', `/api/projects/${target.project}`),
    staleTime: 10_000,
  });
  const request = {
    profileId: detail.project.profile_id,
    route: `/project/${target.project}/session/${target.session}`,
  };
  if (
    await windows?.transfers?.focusPane?.({
      profileId: request.profileId,
      ref: sessionTabRef(
        detail.sessions.find((session) => session.id === target.session) ?? {
          id: target.session,
          kind: 'agent',
        },
      ),
    })
  )
    return true;
  if (!(await projects.route(request)))
    await handleProjectCommand({ ...request, kind: 'navigate-project' });
  return true;
}
