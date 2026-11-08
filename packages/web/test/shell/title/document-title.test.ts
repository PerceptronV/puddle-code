import { afterEach, expect, it, vi } from 'vitest';
import { registerDocumentTitle } from '../../../src/features/shell/title/document-title';

const releases: (() => void)[] = [];
function title(scope: 'shell' | 'workspace', value: string) {
  const release = registerDocumentTitle(scope, value);
  releases.push(release);
  return release;
}
afterEach(() => {
  releases.reverse().forEach((release) => release());
  releases.length = 0;
  vi.unstubAllGlobals();
});

it('keeps project identity through unrelated host status and restores the latest host title on exit', () => {
  vi.stubGlobal('document', { title: 'Puddle' });
  title('shell', 'Laptop');
  const leaveProject = title('workspace', 'Project — Laptop');
  title('shell', '(1) Laptop');
  expect(document.title).toBe('Project — Laptop');
  title('shell', '(1) Renamed laptop');
  expect(document.title).toBe('Project — Laptop');
  leaveProject();
  expect(document.title).toBe('(1) Renamed laptop');
});

it('does not let an old workspace cleanup erase its replacement or its waiting count', () => {
  vi.stubGlobal('document', { title: 'Puddle' });
  title('shell', 'Laptop');
  const leaveOld = title('workspace', 'Old project — Laptop');
  const leaveNew = title('workspace', '● 2 waiting — New project (Laptop)');
  leaveOld();
  expect(document.title).toBe('● 2 waiting — New project (Laptop)');
  leaveNew();
  expect(document.title).toBe('Laptop');
});
