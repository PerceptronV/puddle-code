/**
 * What Settings Sync exports (SPEC §11): the machine-agnostic preferences,
 * grouped by header for the export checklist. Deliberately EXCLUDES anything
 * that can't map 1:1 onto another machine — accounts, repositories, project
 * order, default account, the daemon's agent search path, worktree paths.
 *
 * Each field names the store it lives in so import can route it back:
 * `client` (localStorage clientSettings), `theme` (the theme preference),
 * `profileSettings` (the profile's settings JSON), `profileColumn` (a column on
 * the profile row, patched via PATCH /api/profiles/:id).
 */
export type SyncStore = 'client' | 'theme' | 'profileSettings' | 'profileColumn';

export interface SyncField {
  key: string;
  store: SyncStore;
}
export interface SyncGroup {
  id: string;
  label: string;
  fields: SyncField[];
}

// Group order mirrors the settings sidebar's tab order (the non-exportable
// tabs — Accounts, Notifications, Repositories, Host, Sync — simply absent).
export const SYNC_GROUPS: SyncGroup[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    fields: [
      { key: 'theme', store: 'theme' },
      { key: 'uiFontSize', store: 'client' },
      { key: 'terminalFontSize', store: 'client' },
      { key: 'density', store: 'client' },
      { key: 'reducedMotion', store: 'client' },
      { key: 'terminalScrollback', store: 'client' },
      { key: 'showAllProjectSessions', store: 'client' },
    ],
  },
  {
    id: 'profile',
    label: 'Profile',
    fields: [
      { key: 'branch_prefix', store: 'profileColumn' },
      { key: 'icon', store: 'profileColumn' },
      { key: 'icon_colour', store: 'profileColumn' },
    ],
  },
  {
    id: 'sessions',
    label: 'Sessions',
    fields: [
      { key: 'onboardingTemplate', store: 'profileSettings' },
      { key: 'concurrentTemplate', store: 'profileSettings' },
      { key: 'restartTemplate', store: 'profileSettings' },
      { key: 'tabTitleTemplate', store: 'profileSettings' },
      { key: 'sessionDefaults', store: 'profileSettings' },
      { key: 'allowSkipPermissions', store: 'profileSettings' },
    ],
  },
  {
    id: 'editor',
    label: 'Editor',
    fields: [
      { key: 'editorTabSize', store: 'client' },
      { key: 'editorWordWrap', store: 'client' },
      { key: 'editorLinkSshHost', store: 'client' },
    ],
  },
  { id: 'hotkeys', label: 'Hotkeys', fields: [{ key: 'hotkeys', store: 'profileSettings' }] },
];

/** Current values, per store, for `collectExport` to read. */
export interface SyncSources {
  client: Record<string, unknown>;
  theme: unknown;
  profileSettings: Record<string, unknown>;
  profile: Record<string, unknown>;
}

/** Live setters, per store, for `applyImport` to route into. */
export interface SyncSinks {
  setClient: (patch: Record<string, unknown>) => void;
  setTheme: (value: unknown) => void;
  patchProfileSettings: (patch: Record<string, unknown>) => void;
  patchProfileColumns: (patch: Record<string, unknown>) => void;
}

function readField(field: SyncField, s: SyncSources): unknown {
  switch (field.store) {
    case 'client':
      return s.client[field.key];
    case 'theme':
      return s.theme;
    case 'profileSettings':
      return s.profileSettings[field.key];
    case 'profileColumn':
      return s.profile[field.key];
  }
}

/** Build the export object for the chosen groups: `{ groupId: { key: value } }`. */
export function collectExport(
  selectedGroupIds: string[],
  sources: SyncSources,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const group of SYNC_GROUPS) {
    if (!selectedGroupIds.includes(group.id)) continue;
    const values: Record<string, unknown> = {};
    for (const field of group.fields) {
      const value = readField(field, sources);
      if (value !== undefined) values[field.key] = value;
    }
    if (Object.keys(values).length > 0) out[group.id] = values;
  }
  return out;
}

/** Route an imported object's present fields into the live stores. Returns the
 *  labels of the groups that had something to apply. */
export function applyImport(imported: unknown, sinks: SyncSinks): string[] {
  if (!imported || typeof imported !== 'object') return [];
  const doc = imported as Record<string, unknown>;
  const clientPatch: Record<string, unknown> = {};
  const settingsPatch: Record<string, unknown> = {};
  const columnPatch: Record<string, unknown> = {};
  const applied: string[] = [];

  for (const group of SYNC_GROUPS) {
    const values = doc[group.id];
    if (!values || typeof values !== 'object') continue;
    const bag = values as Record<string, unknown>;
    let any = false;
    for (const field of group.fields) {
      if (!(field.key in bag)) continue;
      any = true;
      const v = bag[field.key];
      if (field.store === 'client') clientPatch[field.key] = v;
      else if (field.store === 'theme') sinks.setTheme(v);
      else if (field.store === 'profileSettings') settingsPatch[field.key] = v;
      else columnPatch[field.key] = v;
    }
    if (any) applied.push(group.label);
  }

  if (Object.keys(clientPatch).length > 0) sinks.setClient(clientPatch);
  if (Object.keys(settingsPatch).length > 0) sinks.patchProfileSettings(settingsPatch);
  if (Object.keys(columnPatch).length > 0) sinks.patchProfileColumns(columnPatch);
  return applied;
}
