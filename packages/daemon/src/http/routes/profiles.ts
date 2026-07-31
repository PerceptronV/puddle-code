import { Hono } from 'hono';
import {
  DEFAULT_BRANCH_PREFIX,
  createProfileRequestSchema,
  patchProfileRequestSchema,
  patchProfileSettingsRequestSchema,
  putUiStateRequestSchema,
  putUntitledRequestSchema,
  untitledNameSchema,
  type CreateUntitledResponse,
  type PutUntitledResponse,
  type UntitledFileResponse,
} from '@puddle/shared';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

      // Untitled drafts (protocol 10.3, SPEC §8): worktree-AGNOSTIC scratch
      // files held under the profile's own subtree until an explicit save-as
      // places them into a worktree. The name schema (`untitled-<n>.md`) is
      // the traversal guard — nothing else is a valid name.
      .post('/:id/untitled', (c) => {
        const profile = deps.profiles.get(hexIdParam(c));
        const dir = join(deps.paths.profilesDir, profile.id, 'untitled');
        mkdirSync(dir, { recursive: true });
        for (let n = 1; n <= 500; n++) {
          const name = `untitled-${n}.md`;
          const target = join(dir, name);
          if (existsSync(target)) continue;
          writeFileSync(target, '');
          return c.json<CreateUntitledResponse>({ name }, 201);
        }
        throw ApiError.conflict('too_many_untitled', 'tidy up some untitled drafts first');
      })
      .get('/:id/untitled/:name', (c) => {
        const profile = deps.profiles.get(hexIdParam(c));
        const name = c.req.param('name') ?? '';
        if (!untitledNameSchema.safeParse(name).success) {
          throw ApiError.badRequest('invalid_name', 'not an untitled draft name');
        }
        const target = join(deps.paths.profilesDir, profile.id, 'untitled', name);
        if (!existsSync(target)) throw ApiError.notFound('untitled draft', name);
        return c.json<UntitledFileResponse>({
          name,
          content: readFileSync(target, 'utf8'),
          mtime_ms: statSync(target).mtimeMs,
        });
      })
      .put('/:id/untitled/:name', async (c) => {
        const profile = deps.profiles.get(hexIdParam(c));
        const name = c.req.param('name') ?? '';
        if (!untitledNameSchema.safeParse(name).success) {
          throw ApiError.badRequest('invalid_name', 'not an untitled draft name');
        }
        const body = await parseBody(c, putUntitledRequestSchema);
        const dir = join(deps.paths.profilesDir, profile.id, 'untitled');
        mkdirSync(dir, { recursive: true });
        const target = join(dir, name);
        writeFileSync(target, body.content, 'utf8');
        return c.json<PutUntitledResponse>({ mtime_ms: statSync(target).mtimeMs });
      })
      .delete('/:id/untitled/:name', (c) => {
        const profile = deps.profiles.get(hexIdParam(c));
        const name = c.req.param('name') ?? '';
        if (!untitledNameSchema.safeParse(name).success) {
          throw ApiError.badRequest('invalid_name', 'not an untitled draft name');
        }
        rmSync(join(deps.paths.profilesDir, profile.id, 'untitled', name), { force: true });
        return c.body(null, 204);
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
