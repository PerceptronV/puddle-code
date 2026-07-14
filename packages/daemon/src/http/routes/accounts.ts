import { mkdirSync } from 'node:fs';
import { Hono } from 'hono';
import {
  createAccountRequestSchema,
  patchAccountRequestSchema,
  type LoginResponse,
} from '@puddle/shared';
import type { AdapterRegistry } from '../../agents/registry.js';
import type { AccountStore } from '../../db/stores/accounts.js';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { PtyExitEvent, PtyManager } from '../../pty/pty-manager.js';
import type { PuddlePaths } from '../../paths.js';
import { idParam, parseBody } from '../validate.js';

export interface AccountRouteDeps {
  accounts: AccountStore;
  profiles: ProfileStore;
  adapters: AdapterRegistry;
  ptys: PtyManager;
  paths: PuddlePaths;
}

export function accountRoutes(deps: AccountRouteDeps): Hono {
  // Login PTYs exiting cleanly mark the account logged in (SPEC §6).
  deps.ptys.on('exit', (e: PtyExitEvent) => {
    const match = /^login-([0-9]+)$/.exec(e.stream);
    if (match && e.exitCode === 0) deps.accounts.setLoggedIn(Number(match[1]), true);
  });

  return new Hono()
    .get('/', (c) => {
      const profile = c.req.query('profile');
      return c.json(deps.accounts.list(profile !== undefined ? Number(profile) : undefined));
    })
    .post('/', async (c) => {
      const body = await parseBody(c, createAccountRequestSchema);
      deps.adapters.get(body.agent_type); // 400 for unknown agent types
      const profile = deps.profiles.get(body.profile_id);
      // Always a fresh directory — puddle NEVER reuses agent config dirs it
      // did not create (SPEC §2).
      const configDir = deps.paths.accountConfigDir(profile.name, body.agent_type, body.label);
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      const account = deps.accounts.create({
        profile_id: body.profile_id,
        agent_type: body.agent_type,
        label: body.label,
        config_dir: configDir,
        skip_permissions_default: body.skip_permissions_default ?? false,
      });
      return c.json(account, 201);
    })
    .patch('/:id', async (c) => {
      const body = await parseBody(c, patchAccountRequestSchema);
      return c.json(
        deps.accounts.setSkipPermissionsDefault(idParam(c), body.skip_permissions_default),
      );
    })
    .post('/:id/login', (c) => {
      const account = deps.accounts.get(idParam(c));
      const adapter = deps.adapters.get(account.agent_type);
      const stream = `login-${account.id}`;
      if (!deps.ptys.has(stream, 'agent')) {
        // Not recorded: login output can carry secrets and needs no replay.
        deps.ptys.spawn(stream, 'agent', adapter.binary, adapter.loginArgs(), {
          cwd: deps.paths.home,
          env: adapter.env(account),
          record: false,
        });
      }
      return c.json<LoginResponse>({ stream, term: 'agent' });
    });
}
