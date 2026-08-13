import type { LucideIcon } from 'lucide-react';

/**
 * Command registry for the ⌘K palette. Features contribute commands with
 * registerCommandSource so later phases (prompt bank, file open, …) extend
 * the palette without touching it.
 */
export interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  icon?: LucideIcon;
  /** Extra fuzzy-match terms beyond the label. */
  keywords?: string;
  shortcut?: string;
  /** Keep the palette mounted when the command transitions to an inline input. */
  closeOnRun?: boolean;
  run(): void;
}

type CommandSource = () => PaletteCommand[];

const sources = new Set<CommandSource>();

export function registerCommandSource(source: CommandSource): () => void {
  sources.add(source);
  return () => sources.delete(source);
}

export function collectCommands(): PaletteCommand[] {
  return [...sources].flatMap((source) => source());
}
