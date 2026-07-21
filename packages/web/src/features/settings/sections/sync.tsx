import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import {
  clientSettings,
  updateClientSettings,
  type ClientSettings,
} from '../../../lib/client-settings';
import {
  usePatchProfile,
  usePatchProfileSettings,
  useProfileSettings,
  useProfiles,
} from '../../../lib/queries';
import { decodeSettings, encodeSettings } from '../../../lib/settings-sync';
import { applyImport, collectExport, SYNC_GROUPS } from '../../../lib/settings-sync-manifest';
import { applyTheme, storedPreference, type ThemePreference } from '../../../lib/theme';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle } from '../parts';

/**
 * Settings → Sync (SPEC §11): export the profile's machine-agnostic settings as
 * one opaque string and import one on another machine. Import is above export;
 * export has a collapsible checklist of which groups to include.
 */
export function SyncSection() {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const profile = useProfiles().data?.find((p) => p.id === profileId);
  const patchSettings = usePatchProfileSettings(profileId ?? '');
  const patchProfile = usePatchProfile();

  const [importText, setImportText] = useState('');
  const [exported, setExported] = useState('');
  const [copied, setCopied] = useState(false);
  const [customise, setCustomise] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SYNC_GROUPS.map((g) => [g.id, true])),
  );

  const onImport = async () => {
    setBusy(true);
    try {
      const doc = await decodeSettings(importText.trim());
      const applied = applyImport(doc, {
        // Import data is loosely typed; each store validates its own writes
        // (the daemon zod-checks profile settings; applyTheme guards the value).
        setClient: (p) => updateClientSettings(p as Partial<ClientSettings>),
        setTheme: (v) => {
          if (typeof v === 'string') applyTheme(v as ThemePreference);
        },
        patchProfileSettings: (p) =>
          patchSettings.mutate(p, { onError: (e) => toast.error(e.message) }),
        patchProfileColumns: (p) => {
          if (profileId)
            patchProfile.mutate(
              { id: profileId, ...p },
              { onError: (e) => toast.error(e.message) },
            );
        },
      });
      if (applied.length === 0) toast.error('Nothing recognised to import.');
      else {
        toast.success(`Imported ${applied.join(', ')}.`);
        setImportText('');
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    setBusy(true);
    try {
      const ids = SYNC_GROUPS.filter((g) => selected[g.id]).map((g) => g.id);
      const doc = collectExport(ids, {
        client: clientSettings() as unknown as Record<string, unknown>,
        theme: storedPreference(),
        profileSettings: (settings.data ?? {}) as Record<string, unknown>,
        profile: (profile ?? {}) as unknown as Record<string, unknown>,
      });
      setExported(await encodeSettings(doc));
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    void navigator.clipboard?.writeText(exported);
    setCopied(true);
  };

  return (
    <div>
      <SectionTitle>Sync</SectionTitle>
      <p className="mb-5 text-xs text-fg-muted">
        Carry your settings between machines as one string. Accounts, repositories, and anything
        machine-specific are never included. Applies to this profile.
      </p>

      <div className="mb-6">
        <h3 className="text-sm font-medium text-fg">Import</h3>
        <p className="mb-2 text-xs text-fg-muted">
          Paste an exported string — only the settings it carries are updated.
        </p>
        <Textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Paste a settings export…"
          rows={3}
          spellCheck={false}
          className="resize-y font-mono text-xs"
        />
        <div className="mt-2">
          <Button size="sm" disabled={!importText.trim() || busy} onClick={() => void onImport()}>
            Import
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-fg">Export</h3>
        <button
          type="button"
          onClick={() => setCustomise((v) => !v)}
          className="mb-2 mt-1 flex items-center gap-1 text-xs text-fg-secondary transition-colors hover:text-fg"
        >
          {customise ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Choose what to include
        </button>
        {customise && (
          <div className="mb-3 flex flex-col gap-2 pl-1">
            {SYNC_GROUPS.map((g) => (
              <label key={g.id} className="flex items-center gap-2 text-sm text-fg">
                <Switch
                  checked={selected[g.id] ?? false}
                  onCheckedChange={(on) => setSelected((s) => ({ ...s, [g.id]: on }))}
                />
                {g.label}
              </label>
            ))}
          </div>
        )}
        <Button size="sm" disabled={busy} onClick={() => void onExport()}>
          Export
        </Button>
        {exported && (
          <div className="mt-2">
            <Textarea
              readOnly
              value={exported}
              rows={3}
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
              className="resize-y font-mono text-xs"
            />
            <div className="mt-2">
              <Button size="sm" variant="secondary" onClick={copy}>
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
