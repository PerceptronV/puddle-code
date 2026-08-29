import type { CompilationCommandSlot } from '@puddle/shared';

/** What the editable field displays: an explicit override, then the live provider default. */
export function commandDraft(slot: CompilationCommandSlot): string {
  return slot.override_command ?? slot.default_command ?? '';
}

/** Saving the exact provider default clears a redundant durable override. */
export function commandOverride(slot: CompilationCommandSlot, draft: string): string | null {
  const command = draft.trim();
  if (command === '') return null;
  return command === slot.default_command ? null : command;
}
