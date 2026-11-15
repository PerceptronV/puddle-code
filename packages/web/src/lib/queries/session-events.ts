import type { QueryClient } from '@tanstack/react-query';
import type { ProjectDetail, Session } from '@puddle/shared';
import type { RenameEvent, StatusEvent } from '../transport/ws';

/** Apply pushed observations without downloading every session again. */
function patchSessions(client: QueryClient, patch: (session: Session) => Session): void {
  for (const [key, data] of client.getQueriesData<Session[]>({ queryKey: ['sessions'] })) {
    if (data) client.setQueryData(key, data.map(patch));
  }
  for (const [key, data] of client.getQueriesData<ProjectDetail>({ queryKey: ['project'] })) {
    if (data) client.setQueryData(key, { ...data, sessions: data.sessions.map(patch) });
  }
}

export function applySessionStatus(client: QueryClient, event: StatusEvent): void {
  patchSessions(client, (session) =>
    session.id === event.session
      ? { ...session, status: event.status, last_activity_at: event.last_activity_at }
      : session,
  );
}

export function applySessionRename(client: QueryClient, event: RenameEvent): void {
  patchSessions(client, (session) =>
    session.id === event.session
      ? {
          ...session,
          title: event.title,
          // Omitted by older hosts; omission must preserve the cached observation.
          agent_title: 'agent_title' in event ? event.agent_title : session.agent_title,
          osc_title: 'osc_title' in event ? event.osc_title : session.osc_title,
        }
      : session,
  );
}
