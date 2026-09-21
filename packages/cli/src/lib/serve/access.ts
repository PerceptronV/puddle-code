import type { ConnectionAuthority } from '../auth/connection-authority.js';
import type { BrowserAuthority, BrowserRecord } from './browser-authority.js';

export interface GatewayAccess {
  authority: ConnectionAuthority;
  browsers: BrowserAuthority;
  browser: BrowserRecord;
}
export function openAccess(access: GatewayAccess, close: () => void) {
  const resource = access.authority.resource(close);
  const unbind = access.browsers.bind(access.browser, close);
  return {
    id: resource.id,
    token: access.authority.credential(),
    valid: () =>
      access.authority.state === 'ready' &&
      resource.valid() &&
      access.browsers.valid(access.browser),
    release: () => {
      resource.release();
      unbind();
    },
  };
}
