import type { HuddleComponent, HuddleJson } from '@puddle/shared';
import type { AccountStore } from '../../db/stores/accounts.js';
import type { ProjectStore } from '../../db/stores/projects.js';
import type { AdapterRegistry } from '../../agents/registry.js';
import { ApiError } from '../../http/errors.js';

export interface HuddleResourceStores {
  accounts?: Pick<AccountStore, 'get'>;
  adapters?: Pick<AdapterRegistry, 'get'>;
  projects: Pick<ProjectStore, 'get'>;
}

/** Resolve explicit host resources; labels and current/default selections are not identities. */
export function huddleResourceBindings(
  stores: HuddleResourceStores,
  profile: string,
  project: string,
  component: HuddleComponent,
  values: Record<string, HuddleJson>,
): Record<string, string> {
  const bindings: Record<string, string> = {};
  const accounts: string[] = [];
  const providers = new Set<string>();
  for (const [name, parameter] of Object.entries(component.parameters)) {
    const value = values[name];
    if (value === undefined) continue;
    if (parameter.editor === 'project') {
      if (typeof value !== 'string' || value !== project)
        throw ApiError.badRequest('huddle_project_unavailable', 'Choose the huddle project id');
      const selected = stores.projects.get(value);
      if (selected.profile_id !== profile || selected.archived)
        throw ApiError.conflict(
          'huddle_project_unavailable',
          'The declared project is unavailable',
        );
      bindings[name] = selected.id;
    } else if (parameter.editor === 'agent') {
      if (!stores.adapters)
        throw ApiError.conflict(
          'huddle_execution_unsupported',
          'Provider resource resolution is unavailable',
        );
      if (typeof value !== 'string' || !value)
        throw ApiError.badRequest('invalid_agent_type', 'Choose an explicit provider id');
      const selected = stores.adapters.get(value);
      if (!selected.scriptedTurns)
        throw ApiError.conflict(
          'huddle_provider_unavailable',
          'The declared provider does not support scripted turns',
        );
      bindings[name] = selected.id;
      providers.add(selected.id);
    } else if (parameter.editor === 'account') {
      if (!stores.accounts)
        throw ApiError.conflict(
          'huddle_execution_unsupported',
          'Account resource resolution is unavailable',
        );
      if (
        (typeof value !== 'string' && typeof value !== 'number') ||
        !/^[1-9][0-9]*$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value))
      )
        throw ApiError.badRequest('invalid_account', 'Choose an explicit positive account id');
      const selected = stores.accounts.get(Number(value));
      if (selected.profile_id !== profile || !selected.logged_in)
        throw ApiError.conflict(
          'huddle_account_unavailable',
          'Choose a logged-in account in this profile',
        );
      bindings[name] = String(selected.id);
      accounts.push(selected.agent_type);
    }
  }
  if (accounts.some((provider) => !providers.has(provider)))
    throw ApiError.conflict(
      'huddle_account_provider_mismatch',
      'Every declared account needs a matching declared provider',
    );
  return bindings;
}
