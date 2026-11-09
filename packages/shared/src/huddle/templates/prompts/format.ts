/** Standard input substitution. Keep self-contained: also shipped as editable node source. */
export function formatPrompt(template: string, input: unknown): string {
  const encoder = new TextEncoder();
  let bytes = encoder.encode(template).length;
  if (bytes > 128 * 1024) throw new Error('Prompt exceeds its byte limit');
  return template.replace(/\{\{\s*input((?:\.[a-zA-Z0-9_-]+)*)\s*\}\}/g, (match, path: string) => {
    let value = input;
    for (const field of path.split('.').filter(Boolean)) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, field))
        throw new Error('Missing prompt input field: ' + path);
      value = (value as Record<string, unknown>)[field];
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) throw new Error('Missing prompt input value');
    bytes += encoder.encode(text).length - encoder.encode(match).length;
    if (bytes > 128 * 1024) throw new Error('Prompt exceeds its byte limit');
    return text;
  });
}
