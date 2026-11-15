import { browserTransport } from '../transport/browser-transport';
import { sshMode } from '../transport/ssh-mode';
import { desktopWindowContext } from '../../features/windows/window-context';

export function projectCacheScope(): string {
  const remote = browserTransport();
  if (remote) return remote.projectCacheScope ?? remote.scope;
  const host = desktopWindowContext()?.hostId;
  return host
    ? JSON.stringify(['desktop', host])
    : JSON.stringify(['frontend', window.location.origin, sshMode()]);
}
