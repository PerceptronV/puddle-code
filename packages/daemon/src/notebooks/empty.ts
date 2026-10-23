/** Only creation gets a template; saving empty/invalid existing files stays literal. */
export function newFileContent(path: string, content = ''): string {
  if (!path.toLowerCase().endsWith('.ipynb') || content.trim()) return content;
  return (
    JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 2) + '\n'
  );
}
