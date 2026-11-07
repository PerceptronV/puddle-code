import { useState } from 'react';
import { Check, ChevronDown, Settings2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from '../../../components/ui/command';
import { useClientSettings } from '../../../lib/settings/client-settings';
import type { EditorTab } from '../tabs/editor-tabs';
import { editorLanguages, languageForPath } from '../monaco/languages';
import { fileSettingsStore } from './file-settings-store';
import { useFileOverrides } from './file-editor-settings';

export function FileEditorSettingsMenu({
  tab,
  onOpenChange,
}: {
  tab: EditorTab;
  onOpenChange?: (open: boolean) => void;
}) {
  const { key, overrides } = useFileOverrides(tab);
  const defaults = useClientSettings();
  const [languageOpen, setLanguageOpen] = useState(false);
  const languages = editorLanguages();
  const automatic = languageForPath(tab.path);
  const label = (id: string) => languages.find((language) => language.id === id)?.label ?? id;
  const languageLabel = overrides.language
    ? label(overrides.language)
    : `Automatic (${label(automatic)})`;
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Editor settings"
          title="Editor settings"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex cursor-pointer p-0.5 text-fg-muted transition-colors hover:text-fg"
        >
          <Settings2 className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Editor settings for this file"
        className="w-72 space-y-3 p-3 text-xs"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <div>
          <p className="font-medium">Editor settings</p>
          <p className="mt-1 truncate text-fg-muted" title={tab.path}>
            {tab.path.split('/').pop()}
          </p>
        </div>
        <div className="space-y-1">
          <p>Tab size</p>
          <Select
            value={overrides.tabSize?.toString() ?? 'default'}
            onValueChange={(value) =>
              fileSettingsStore.update(key, {
                tabSize: value === 'default' ? undefined : Number(value),
              })
            }
          >
            <SelectTrigger aria-label="Tab size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default ({defaults.editorTabSize})</SelectItem>
              {Array.from({ length: 8 }, (_, index) => index + 1).map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <p>Word wrap</p>
          <Select
            value={overrides.wordWrap === undefined ? 'default' : overrides.wordWrap ? 'on' : 'off'}
            onValueChange={(value) =>
              fileSettingsStore.update(key, {
                wordWrap: value === 'default' ? undefined : value === 'on',
              })
            }
          >
            <SelectTrigger aria-label="Word wrap">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
                Default ({defaults.editorWordWrap ? 'on' : 'off'})
              </SelectItem>
              <SelectItem value="on">On</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <p>Syntax highlighting</p>
          <Popover open={languageOpen} onOpenChange={setLanguageOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Syntax highlighting"
                className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md bg-elevated px-2.5 py-2 text-left hover:text-fg"
              >
                <span className="truncate">{languageLabel}</span>
                <ChevronDown className="size-3.5 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="end">
              <Command>
                <CommandInput aria-label="Find a language" placeholder="Find a language…" />
                <CommandList>
                  <CommandEmpty>No matching languages</CommandEmpty>
                  {[
                    { id: 'automatic', label: `Automatic (${label(automatic)})`, keywords: [] },
                    ...languages,
                  ].map((language) => (
                    <CommandItem
                      key={language.id}
                      value={language.id}
                      keywords={[language.label, ...language.keywords]}
                      onSelect={() => {
                        fileSettingsStore.update(key, {
                          language: language.id === 'automatic' ? undefined : language.id,
                        });
                        setLanguageOpen(false);
                      }}
                    >
                      <span className="flex-1">{language.label}</span>
                      {(overrides.language ?? 'automatic') === language.id && (
                        <Check className="size-3.5" />
                      )}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <p className="text-fg-muted">
          Only this file, in this window.
          {tab.path.toLowerCase().endsWith('.ipynb') &&
            ' Syntax highlighting applies to the JSON source; cells keep their own languages.'}
        </p>
      </PopoverContent>
    </Popover>
  );
}
