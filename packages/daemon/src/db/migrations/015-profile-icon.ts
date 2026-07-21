/**
 * A profile can pick its own glyph and colour (SPEC §11): `icon` is a lucide
 * icon name (kebab-case, e.g. `rocket`) and `icon_colour` a theme-colour key
 * (e.g. `blue`, `gold`) that the web maps to a theme-aware token. Both nullable
 * — null falls back to the default person glyph in the heading colour. Plain
 * additive columns, so no table rebuild.
 */
export const migration015 = {
  version: 15,
  name: 'profile-icon',
  sql: `
ALTER TABLE profiles ADD COLUMN icon TEXT;
ALTER TABLE profiles ADD COLUMN icon_colour TEXT;
`,
};
