import { File } from 'lucide-react';
import { cn } from '../../lib/utils';

// Locally bundled Material Icon Theme artwork; provenance and licence live
// beside the SVGs in public/file-icons/material. No remote icon requests.
const BY_NAME: Record<string, string> = {
  'package.json': 'npm',
  'package-lock.json': 'npm',
  '.npmrc': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'pnpm-workspace.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  dockerfile: 'docker',
  '.dockerignore': 'docker',
  'compose.yaml': 'docker',
  'compose.yml': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  'readme.md': 'readme',
  license: 'license',
  licence: 'license',
  'license.md': 'license',
  'licence.md': 'license',
  '.prettierignore': 'prettier',
  '.prettierrc': 'prettier',
  '.prettierrc.json': 'prettier',
  '.eslintrc': 'eslint',
  '.eslintrc.json': 'eslint',
  '.eslintignore': 'eslint',
  '.env': 'tune',
  'go.mod': 'go-mod',
  'go.sum': 'go-mod',
  'cargo.toml': 'rust',
  'cargo.lock': 'rust',
  'tsconfig.json': 'typescript-def',
};

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  'd.ts': 'typescript-def',
  'd.mts': 'typescript-def',
  'd.cts': 'typescript-def',
  tsx: 'react_ts',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'react',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'h',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'hpp',
  hxx: 'hpp',
  cs: 'csharp',
  dart: 'dart',
  swift: 'swift',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  plist: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  sql: 'database',
  sqlite: 'database',
  db: 'database',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'settings',
  cfg: 'settings',
  conf: 'settings',
  env: 'tune',
  lock: 'lock',
  csv: 'table',
  tsv: 'table',
  xlsx: 'table',
  xls: 'table',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  txt: 'document',
  rtf: 'document',
  log: 'document',
  pdf: 'pdf',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'less',
  sh: 'console',
  bash: 'console',
  zsh: 'console',
  fish: 'console',
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  heic: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  zip: 'zip',
  tar: 'zip',
  gz: 'zip',
  tgz: 'zip',
  rar: 'zip',
  '7z': 'zip',
  bz2: 'zip',
  xz: 'zip',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  ipynb: 'jupyter',
};

const BY_PREFIX: Record<string, string> = {
  'eslint.config.': 'eslint',
  '.eslintrc.': 'eslint',
  'prettier.config.': 'prettier',
  '.prettierrc.': 'prettier',
  'vite.config.': 'vite',
  'vitest.config.': 'vitest',
  'tsconfig.': 'typescript-def',
  '.env.': 'tune',
  'dockerfile.': 'docker',
};

function fileIcon(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (Object.hasOwn(BY_NAME, lower)) return BY_NAME[lower];
  for (const [prefix, icon] of Object.entries(BY_PREFIX)) {
    if (lower.startsWith(prefix)) return icon;
  }
  // Try compound suffixes first (foo.d.ts), then the final extension.
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('.');
    if (Object.hasOwn(BY_EXTENSION, suffix)) return BY_EXTENSION[suffix];
  }
}

/** Keep type colours distinct from the filename's Git status decoration. */
export function FileTypeIcon({
  name,
  dimmed,
  className,
}: {
  name: string;
  dimmed?: boolean;
  className?: string;
}) {
  const icon = fileIcon(name);
  return icon ? (
    <img
      src={`/file-icons/material/${icon}.svg`}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('size-4.5 shrink-0', dimmed && 'opacity-50', className)}
    />
  ) : (
    <File aria-hidden="true" className={cn('size-4.5 shrink-0 text-fg-muted', className)} />
  );
}

/** Filled navigator folder; expansion changes its silhouette, not its hue. */
export function FolderIcon({
  open = false,
  dimmed = false,
  className,
}: {
  open?: boolean;
  dimmed?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn('size-4.5 shrink-0 text-explorer-folder', dimmed && 'opacity-50', className)}
    >
      <path d="M3 3h5l2 2h11a1 1 0 0 1 1 1v2H2V4a1 1 0 0 1 1-1Z" />
      <path
        d={open ? 'M2 9h21l-3 11H3a1 1 0 0 1-1-1Z' : 'M2 9h20v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z'}
      />
    </svg>
  );
}
