import { z } from 'zod';
import { profileId, projectId } from '../../api/common.js';
import { desktopWindowRouteSchema } from './identity.js';
import type { DesktopPaneDetach } from './transfers.js';

export const desktopProjectFocusSchema = z.object({ profileId, projectId });
export type DesktopProjectFocus = z.infer<typeof desktopProjectFocusSchema>;
export const desktopProjectRouteSchema = z.object({ profileId, route: desktopWindowRouteSchema });
export type DesktopProjectRoute = z.infer<typeof desktopProjectRouteSchema>;
export const desktopProjectCommandSchema = z.discriminatedUnion('kind', [
  desktopProjectFocusSchema.extend({ kind: z.literal('open-project') }),
  desktopProjectRouteSchema.extend({ kind: z.literal('navigate-project') }),
]);
export type DesktopProjectCommand = z.infer<typeof desktopProjectCommandSchema>;
export interface DesktopWindowProjectsBridge {
  prepare(request: DesktopPaneDetach): Promise<void>;
  /** Focus/reopen an owner, or delegate opening from a detached window to its host. */
  focus(request: DesktopProjectFocus): Promise<boolean>;
  /** True when main handled navigation, including a returned workspace handoff. */
  route(request: DesktopProjectRoute): Promise<boolean>;
}
