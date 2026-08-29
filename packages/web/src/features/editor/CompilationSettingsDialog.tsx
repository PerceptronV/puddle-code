import { useEffect, useState } from 'react';
import type {
  CompilationMode,
  CompilationSettingsRequest,
  CompilationSettingsResponse,
} from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { updateCompilationSettings, useCompilationSettings } from '../../lib/compilation-queries';
import { basename } from '../explorer/explorer-paths';
import { commandDraft, commandOverride } from './compilation-settings';

type Drafts = Partial<Record<CompilationMode, string>>;

export function CompilationSettingsDialog({
  request,
  onOpenChange,
}: {
  request: CompilationSettingsRequest | null;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useCompilationSettings(request);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    setDrafts(
      Object.fromEntries(
        settings.data.commands.map((slot) => [slot.mode, commandDraft(slot)]),
      ) as Drafts,
    );
    setError(null);
  }, [settings.data]);

  const save = async () => {
    if (!request || !settings.data) return;
    const empty = settings.data.commands.find((slot) => (drafts[slot.mode] ?? '').trim() === '');
    if (empty) {
      setError(`${slotLabel(empty.mode)} needs a command or its provider default.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let latest: CompilationSettingsResponse | null = null;
      for (const slot of settings.data.commands) {
        const next = commandOverride(slot, drafts[slot.mode] ?? '');
        if (next === slot.override_command) continue;
        latest = await updateCompilationSettings({
          ...request,
          mode: slot.mode,
          command: next,
        });
      }
      if (latest) {
        // The dialog is closing, but keep this query honest if it is reopened.
        await settings.refetch();
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t save compilation settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{settings.data?.display_name ?? 'Compilation'} settings</DialogTitle>
          <DialogDescription>
            {request ? basename(request.source.path) : 'This file'} · saved for this file in this
            project
          </DialogDescription>
        </DialogHeader>

        {settings.isLoading ? (
          <p className="py-4 text-sm text-fg-muted">Loading commands…</p>
        ) : settings.isError ? (
          <p className="py-4 text-sm text-danger">
            {settings.error instanceof Error ? settings.error.message : 'Couldn’t load commands'}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {settings.data?.commands.map((slot) => {
              const value = drafts[slot.mode] ?? '';
              const usingDefault = slot.default_command !== null && value === slot.default_command;
              return (
                <label key={slot.mode} className="flex flex-col gap-1.5">
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-fg">{slotLabel(slot.mode)}</span>
                    <span className="text-xs text-fg-muted">
                      {slot.mode === 'on_demand'
                        ? 'Runs when you click the play icon.'
                        : 'Runs when eager mode starts, then after this file or a discovered dependency changes on disk.'}
                    </span>
                  </span>
                  <textarea
                    rows={3}
                    spellCheck={false}
                    value={value}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [slot.mode]: event.target.value }))
                    }
                    className="resize-y rounded-md bg-surface px-2.5 py-2 font-mono text-xs leading-relaxed text-fg outline-none transition-colors focus:bg-ground"
                    aria-label={`${slotLabel(slot.mode)} command`}
                  />
                  <span className="flex min-h-6 items-center justify-between gap-3 text-xs text-fg-muted">
                    <span>{usingDefault ? 'Using the provider default' : 'Custom command'}</span>
                    {slot.default_command !== null && !usingDefault && (
                      <button
                        type="button"
                        onClick={() =>
                          setDrafts((current) => ({
                            ...current,
                            [slot.mode]: slot.default_command ?? '',
                          }))
                        }
                        className="rounded-sm px-1.5 py-0.5 text-fg-secondary transition-colors hover:bg-surface hover:text-fg"
                      >
                        Use default
                      </button>
                    )}
                  </span>
                </label>
              );
            })}

            {(settings.data?.variables.length ?? 0) > 0 && (
              <p className="text-xs leading-relaxed text-fg-muted">
                Available values:{' '}
                {settings.data?.variables.map((variable, index) => (
                  <span key={variable.placeholder} title={variable.description}>
                    {index > 0 && ' · '}
                    <code className="font-mono text-fg-secondary">{variable.placeholder}</code>
                  </span>
                ))}
              </p>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!settings.data || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function slotLabel(mode: CompilationMode): string {
  return mode === 'on_demand' ? 'When clicked' : 'Upon file change';
}
