import { z } from 'zod';
import { profileId } from '../../api/common.js';
import { desktopWindowIdSchema } from './identity.js';
import { desktopWorkspaceVersionSchema } from './content.js';
import { desktopWindowTransferSchema } from './transfers.js';

/** Native geometry is parsed by the shell using its existing placement migration. */
export const desktopWindowStateSchema = z.object({
  version: z.literal(2),
  entries: z.record(
    desktopWindowIdSchema,
    z.object({
      record: z.unknown(),
      open: z.boolean(),
      /** Explicit project closure retains its workspace for the next host visit. */
      returnedProject: z.boolean().optional(),
      workspaces: z.record(profileId, desktopWorkspaceVersionSchema),
    }),
  ),
  pending: z.record(desktopWindowIdSchema, desktopWindowTransferSchema),
  outcomes: z.record(
    desktopWindowIdSchema,
    z.object({
      status: z.enum(['committed', 'cancelled']),
      sourceId: desktopWindowIdSchema,
      destinationId: desktopWindowIdSchema,
      profileId: profileId.optional(),
    }),
  ),
});
