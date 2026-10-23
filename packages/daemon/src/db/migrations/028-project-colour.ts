/** Null preserves existing project-name styling; chosen colours use theme tokens. */
export const migration028 = {
  version: 28,
  name: 'project-colour',
  sql: `
ALTER TABLE projects ADD COLUMN colour TEXT;
`,
};
