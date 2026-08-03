/**
 * The collapsed sidebar rail labels each project with a ≤5-character uppercase
 * abbreviation (SPEC §12). Stored per project (`project.abbrev`, 12.1) and
 * user-editable; projects from before the field derive it from the name — the
 * same first-five-characters the rail always showed, uppercased.
 */
export const ABBREV_MAX = 5;

/** The derived fallback for a project without a stored abbreviation. */
export function deriveAbbrev(name: string): string {
  return name.trim().slice(0, ABBREV_MAX).toUpperCase();
}

/** The label to show: the stored abbreviation, else the derived one. */
export function projectAbbrev(project: { name: string; abbrev?: string | null }): string {
  return project.abbrev ?? deriveAbbrev(project.name);
}

/** Canonicalise user input: uppercase, trimmed, clamped to the length cap. */
export function normaliseAbbrev(input: string): string {
  return input.trim().toUpperCase().slice(0, ABBREV_MAX);
}
