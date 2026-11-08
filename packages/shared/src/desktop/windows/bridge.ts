import type { DesktopWindowContext } from './identity.js';
import type {
  DesktopWorkspaceVersion,
  DesktopWindowWrite,
  DesktopWindowWriteResult,
} from './content.js';
import type { DesktopWindowTransfersBridge } from './transfers.js';
import type { DesktopWindowProjectsBridge } from './projects.js';
import type { DesktopWindowLifecycleBridge } from './commands.js';
import type { DesktopWindowLayoutsBridge } from './arrangements.js';
import type { DesktopWindowEffectsBridge } from './effects.js';

/** Capability-detected private bridge, independent of daemon feature availability. */
export interface DesktopWindowsBridge {
  version: 1;
  /** Huddle tab identity and version-4 recovery persistence. */
  huddles?: true;
  context(): Promise<DesktopWindowContext>;
  /** Checkpoint this window before a renderer-requested reload. */
  reload?(): Promise<void>;
  read(profileId: string): Promise<DesktopWorkspaceVersion | null>;
  write(request: DesktopWindowWrite): Promise<DesktopWindowWriteResult>;
  lifecycle?: DesktopWindowLifecycleBridge;
  transfers?: DesktopWindowTransfersBridge;
  projects?: DesktopWindowProjectsBridge;
  layouts?: DesktopWindowLayoutsBridge;
  effects?: DesktopWindowEffectsBridge;
}
