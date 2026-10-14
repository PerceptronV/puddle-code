import { connect, type Socket } from 'node:net';
import { notificationPreferencesSchema, type AgentNotification } from '@puddle/shared';
import { ipcPath, privatePath } from '@puddle/shared/node';
import type { SessionService, SessionServiceDeps } from './service.js';

/** Send content-free attention signals to the profile's same-user connector. */
export function subscribePushNotifications(
  home: string,
  service: SessionService,
  stores: Pick<SessionServiceDeps, 'sessions' | 'projects' | 'profiles'>,
): () => void {
  const sockets = new Set<Socket>();
  const notify = (event: AgentNotification) => {
    if (sockets.size >= 32) return;
    try {
      const session = stores.sessions.get(event.session);
      const project = stores.projects.get(session.project_id);
      const prefs = notificationPreferencesSchema.safeParse(
        stores.profiles.getSettings(project.profile_id)['notifications'] ?? {},
      );
      if (!prefs.success || !prefs.data.desktop || prefs.data.muted_projects.includes(project.id))
        return;
      const path = ipcPath(home, `remote-${project.profile_id}`);
      privatePath(path);
      const socket = connect(path);
      sockets.add(socket);
      socket.setTimeout(1500, () => socket.destroy());
      socket.on('connect', () => socket.end(JSON.stringify({ t: 'notify', id: event.id }) + '\n'));
      socket.on('data', () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
    } catch {
      /* No configured connector is ordinary local-only use. */
    }
  };
  service.on('agent-notification', notify);
  return () => {
    service.off('agent-notification', notify);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}
