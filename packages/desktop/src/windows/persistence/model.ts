import type {
  DesktopWindowTransfer,
  DesktopWorkspaceVersion,
  DesktopArrangementTransaction,
  DesktopArrangementOutcome,
} from '@puddle/shared';
import type { ReopenWindow } from '../../reopen.js';

export interface WindowState {
  version: 4;
  entries: Record<
    string,
    {
      record: ReopenWindow;
      open: boolean;
      returnedProject?: boolean;
      workspaces: Record<string, DesktopWorkspaceVersion>;
    }
  >;
  pending: Record<string, DesktopWindowTransfer>;
  arrangements: Record<string, DesktopArrangementTransaction>;
  arrangementOutcomes: Record<string, DesktopArrangementOutcome>;
  outcomes: Record<
    string,
    {
      status: 'committed' | 'cancelled';
      sourceId: string;
      destinationId: string;
      profileId?: string;
    }
  >;
}
