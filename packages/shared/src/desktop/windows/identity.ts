import { z } from 'zod';
import { profileId, projectId } from '../../api/common.js';
import type { TabRef } from '../../api/workspace/ui-state.js';

/** Private desktop IPC/persistence identity; never selects a host transport. */
export const desktopWindowIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)
  .refine((id) => id !== 'constructor' && id !== 'prototype', 'Invalid window identity');

export const desktopWindowIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ id: desktopWindowIdSchema, kind: z.literal('host') }),
  z.object({
    id: desktopWindowIdSchema,
    kind: z.literal('project'),
    profileId,
    projectId,
  }),
  z.object({
    id: desktopWindowIdSchema,
    kind: z.literal('pane'),
    profileId,
    projectId,
  }),
]);
export type DesktopWindowIdentity = z.infer<typeof desktopWindowIdentitySchema>;

/** Only application routes are durable; invitations and query parameters are not. */
export const desktopWindowRouteSchema = z
  .string()
  .max(256)
  .regex(/^\/(?:project\/[0-9a-f]{10}(?:\/session\/[0-9a-f-]{36})?|settings(?:\/[a-z-]+)?)?$/);

export interface DesktopWindowContext {
  identity: DesktopWindowIdentity;
  /** Opaque, shell-selected host association for compatible drag destinations. */
  hostId: string;
  /** A newly opened destination remains read-only until its source commits. */
  stagingTransfer?: string;
  /** An arrangement destination must remain fenced until every participant has accepted. */
  stagingArrangement?: string;
}

/** Window lookup includes a following preview's actual target, not just its slot name. */
export function desktopTabKey(ref: TabRef): string {
  if (ref.type === 'terminal') return JSON.stringify(['terminal', ref.session]);
  const tab = ref.tab;
  return JSON.stringify([
    'editor',
    tab.kind ?? 'file',
    tab.session,
    tab.path,
    tab.root ?? null,
    tab.sha ?? null,
    tab.git_area ?? null,
    tab.view === 'linked' || tab.view === 'locked' ? tab.view : null,
  ]);
}
