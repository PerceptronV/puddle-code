import { ZodError } from 'zod';

/** Surface one useful issue instead of Zod's serialized diagnostic array. */
export function huddleEditError(error: unknown, fallback: string): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    if (!issue) return fallback;
    if (issue.path.includes('colour'))
      return 'Choose a preset node colour or a six-digit hex colour.';
    const field = issue.path.map(String).join('.');
    return `${field ? `${field}: ` : ''}${issue.message}`;
  }
  return error instanceof Error ? error.message : fallback;
}
