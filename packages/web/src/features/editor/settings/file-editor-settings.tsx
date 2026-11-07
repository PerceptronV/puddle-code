import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { useClientSettings } from '../../../lib/settings/client-settings';
import { browserScope } from '../../../lib/transport/browser-transport';
import { useCurrentProfileId } from '../../profile/profile-store';
import type { EditorTab } from '../tabs/editor-tabs';
import { fileSettingsKey, fileSettingsStore } from './file-settings-store';

export function useFileOverrides(tab: EditorTab) {
  const profile = useCurrentProfileId();
  const key = fileSettingsKey(browserScope('editor-settings'), profile, tab);
  const overrides = useSyncExternalStore(fileSettingsStore.subscribe, () =>
    fileSettingsStore.get(key),
  );
  return { key, overrides };
}

const FileSettingsContext = createContext<ReturnType<typeof useFileOverrides> | null>(null);

export function FileEditorSettingsProvider({
  tab,
  children,
}: {
  tab: EditorTab;
  children: ReactNode;
}) {
  const value = useFileOverrides(tab);
  return <FileSettingsContext value={value}>{children}</FileSettingsContext>;
}

export function useFileEditorSettings() {
  const defaults = useClientSettings();
  const file = useContext(FileSettingsContext);
  return {
    ...defaults,
    editorTabSize: file?.overrides.tabSize ?? defaults.editorTabSize,
    editorWordWrap: file?.overrides.wordWrap ?? defaults.editorWordWrap,
    editorLanguage: file?.overrides.language,
    fileSettingsKey: file?.key,
  };
}
