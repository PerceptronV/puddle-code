import type { EditorTab } from '../tabs/editor-tabs';

export interface FileEditorOverrides {
  tabSize?: number;
  wordWrap?: boolean;
  language?: string;
}

/** Same file in another pane shares settings; unrelated hosts, roots and drafts do not. */
export function fileSettingsKey(scope: string, profile: string | null, tab: EditorTab): string {
  return JSON.stringify([
    scope,
    tab.kind === 'untitled' ? ['draft', profile] : ['file', tab.session, tab.root],
    tab.path,
    tab.kind === 'commit' ? tab.sha : null,
  ]);
}

const EMPTY: Readonly<FileEditorOverrides> = Object.freeze({});

/** Window-local overrides survive tab remounts, with bounded retention. */
export class FileSettingsStore {
  private entries = new Map<string, Readonly<FileEditorOverrides>>();
  private listeners = new Set<() => void>();

  constructor(private readonly limit = 500) {}

  get = (key: string): Readonly<FileEditorOverrides> => this.entries.get(key) ?? EMPTY;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(key: string, patch: FileEditorOverrides): void {
    const next = { ...this.get(key), ...patch };
    this.entries.delete(key);
    if (next.tabSize !== undefined || next.wordWrap !== undefined || next.language !== undefined) {
      this.entries.set(key, next);
    }
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    for (const listener of this.listeners) listener();
  }
}

export const fileSettingsStore = new FileSettingsStore();
