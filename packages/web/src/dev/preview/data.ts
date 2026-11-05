import { notebookSample, pdfSample } from './samples';
import {
  daemonConfigSchema,
  sessionSchema,
  profileSchema,
  profileSettingsSchema,
  projectSchema,
  repoWithOrphansSchema,
  uiStateSnapshotSchema,
  PROTOCOL_VERSION,
} from '@puddle/shared';

export const profile = profileSchema.parse({
  id: '0000000001',
  name: 'Preview',
  branch_prefix: 'preview/',
  created_at: '2026-11-04T00:00:00.000Z',
});
export const project = projectSchema.parse({
  id: '0000000002',
  profile_id: profile.id,
  repo_id: 1,
  name: 'puddle',
  abbrev: 'PUDDL',
  created_at: profile.created_at,
  updated_at: profile.created_at,
});
export const repo = repoWithOrphansSchema.parse({
  id: 1,
  path: '/preview/puddle',
  default_base_branch: 'main',
  onboarding_notes: null,
  fetch_enabled: false,
  last_fetched_at: null,
  orphan_worktrees: [],
});
export const sessions = ['Explore the interface', 'Review the layout'].map((title, index) =>
  sessionSchema.parse({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    project_id: project.id,
    account_id: null,
    worktree_path: repo.path,
    base_branch: 'main',
    branch: 'main',
    separate_branch: false,
    kind: 'terminal',
    agent_type: null,
    agent_session_ref: null,
    title,
    status: 'exited',
    skip_permissions: false,
    created_at: profile.created_at,
    updated_at: profile.created_at,
    last_activity_at: profile.created_at,
  }),
);
export const settings = profileSettingsSchema.parse({});
export const config = daemonConfigSchema.parse({ displayName: 'UI preview' });
export const version = { version: '0.4.1', protocol: PROTOCOL_VERSION };
export const state = {
  updated_at: profile.created_at,
  ui_state: uiStateSnapshotSchema.parse({ sidebar_mode: 'files', sidebar_collapsed: false }),
};

// Deliberately synthetic: never read the user's files or credentials.
export const files = new Map<string, string>([
  ['examples/preview.ipynb', notebookSample],
  ['examples/preview.pdf', pdfSample],
  [
    'README.md',
    '# Puddle UI preview\n\nThis is a sample project for exploring the interface.\n\n- Expand folders and open files.\n- Try light/dark themes and density in Settings.\n- Edit these sample files; saves last until this page reloads.\n\nNo daemon or agent is running in this preview.\n',
  ],
  [
    'package.json',
    '{\n  "name": "puddle-preview",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n',
  ],
  ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
  ['pnpm-workspace.yaml', 'packages:\n  - packages/*\n'],
  ['.gitignore', 'node_modules/\ndist/\n'],
  ['.prettierrc.json', '{ "singleQuote": true }\n'],
  ['eslint.config.js', 'export default [];\n'],
  ['vitest.config.ts', 'export default { test: { environment: "node" } };\n'],
  ['HUMANS.md', '# Design\n\nMinimal surfaces, generous spacing, responsive hover states.\n'],
  ['docs/design.md', '# Explorer\n\nRounded selections and coloured file icons.\n'],
  ['scripts/build.mjs', 'console.log("Build the preview");\n'],
  [
    'packages/web/src/App.tsx',
    'export function App() {\n  return <main>Hello, Puddle.</main>;\n}\n',
  ],
  ['packages/web/src/styles/tokens.css', ':root {\n  --preview-spacing: 1rem;\n}\n'],
  ['packages/web/package.json', '{ "name": "@puddle/web" }\n'],
  ['packages/daemon/src/index.ts', '// Sample daemon entry point.\nexport {};\n'],
  [
    'examples/ContentView.swift',
    'import SwiftUI\n\nstruct ContentView: View {\n  var body: some View { Text("Hello, Puddle") }\n}\n',
  ],
  ['examples/analysis.py', 'def greet(name):\n    return f"Hello, {name}"\n'],
  ['examples/main.rs', 'fn main() {\n    println!("Hello, Puddle");\n}\n'],
  ['node_modules/.placeholder', 'Sample ignored folder.\n'],
]);

export function tree(path: string) {
  const prefix = path ? `${path}/` : '';
  const entries = new Map<
    string,
    { name: string; type: 'dir' | 'file'; size: number | null; symlink: boolean }
  >();
  for (const [file, content] of files) {
    if (!file.startsWith(prefix)) continue;
    const relative = file.slice(prefix.length);
    const name = relative.split('/')[0]!;
    const dir = relative.includes('/');
    entries.set(name, {
      name,
      type: dir ? 'dir' : 'file',
      size: dir ? null : content.length,
      symlink: false,
    });
  }
  return {
    path,
    entries: [...entries.values()].sort(
      (a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name),
    ),
  };
}

export const originalFiles = new Map(files);
export const modifiedTimes = new Map([...files.keys()].map((path) => [path, 1]));
