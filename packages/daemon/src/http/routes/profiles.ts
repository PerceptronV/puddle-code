import { Hono } from 'hono';
import {
  DEFAULT_BRANCH_PREFIX,
  createProfileRequestSchema,
  patchProfileRequestSchema,
  patchProfileSettingsRequestSchema,
  putUiStateRequestSchema,
} from '@puddle/shared';
import { join } from 'node:path';
import type { AdapterRegistry } from '../../agents/registry.js';
import type { AccountStore } from '../../db/stores/accounts.js';
import type { ProfileStateStore } from '../../db/stores/profile-states.js';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { RemovalStore } from '../../db/stores/removals.js';
import type { PuddlePaths } from '../../paths.js';
import { ApiError } from '../errors.js';
import { removeDirWithin } from '../fs-cleanup.js';
import { hexIdParam, parseBody } from '../validate.js';

export function profileRoutes(deps: {
  profiles: ProfileStore;
  profileStates: ProfileStateStore;
  accounts: AccountStore;
  adapters: AdapterRegistry;
  removals: RemovalStore;
  paths: PuddlePaths;
}): Hono {
  return (
    new Hono()
      .get('/', (c) => c.json(deps.profiles.list()))
      .post('/', async (c) => {
        const body = await parseBody(c, createProfileRequestSchema);
        const profile = deps.profiles.create({
          name: body.name,
          // Omitted → the puddle/ default; an explicit '' still means no prefix.
          branch_prefix: body.branch_prefix ?? DEFAULT_BRANCH_PREFIX,
        });
        return c.json(profile, 201);
      })
      .patch('/:id', async (c) => {
        const id = hexIdParam(c);
        const body = await parseBody(c, patchProfileRequestSchema);
        let profile = deps.profiles.get(id); // 404 before any write
        // Apply whichever fields were sent; a name clash 409s before touching the prefix.
        if (body.name !== undefined) profile = deps.profiles.setName(id, body.name);
        if (body.branch_prefix !== undefined) {
          profile = deps.profiles.setBranchPrefix(id, body.branch_prefix);
        }
        if (body.icon !== undefined || body.icon_colour !== undefined) {
          profile = deps.profiles.setAppearance(id, {
            icon: body.icon,
            icon_colour: body.icon_colour,
          });
        }
        return c.json(profile);
      })
      .delete('/:id', (c) => {
        const id = hexIdParam(c);
        // 409 while any of its sessions is non-archived; cascade otherwise.
        deps.removals.deleteProfile(id);
        removeDirWithin(deps.paths.profilesDir, join(deps.paths.profilesDir, id));
        return c.body(null, 204);
      })
      // Workspace ui_state is profile-keyed (SPEC §11): one snapshot per
      // identity, shared across every project the profile opens. No seeding
      // from other profiles — a fresh profile starts with a fresh workspace.
      .get('/:id/state', (c) => {
        const profile = deps.profiles.get(hexIdParam(c));
        const state = deps.profileStates.get(profile.id);
        if (!state)
          throw new ApiError(404, 'no_state', `profile ${profile.id} has no saved ui state`);
        return c.json(state);
      })
      .put('/:id/state', async (c) => {
        const profile = deps.profiles.get(hexIdParam(c));
        const body = await parseBody(c, putUiStateRequestSchema);
        return c.json(deps.profileStates.put(profile.id, body.ui_state));
      })
      .get('/:id/settings', (c) => c.json(deps.profiles.getSettings(hexIdParam(c))))
      .patch('/:id/settings', async (c) => {
        const id = hexIdParam(c);
        const patch = await parseBody(c, patchProfileSettingsRequestSchema);
        const wasOpen = deps.profiles.getSettings(id).allowSkipPermissions === true;
        const settings = deps.profiles.patchSettings(id, patch);
        // Opening the skip-permissions gate is the user's confirmation (SPEC §11):
        // record each skip-capable account's one-time acceptance so the flag we
        // pass at launch actually takes effect (e.g. Claude's bypass disclaimer).
        if (!wasOpen && settings.allowSkipPermissions === true) {
          for (const account of deps.accounts.list(id)) {
            try {
              deps.adapters.get(account.agent_type).acceptSkipPermissions?.(account);
            } catch {
              // A missing adapter or unwritable config dir must not fail the toggle.
            }
          }
        }
        return c.json(settings);
      })
  );
}
