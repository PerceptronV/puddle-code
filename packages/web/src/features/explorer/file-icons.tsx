import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * A curated, self-contained file-type icon theme (SPEC §8): per-extension
 * lucide glyph SHAPES in the heading colour (`text-fg`) — deliberately
 * monochrome, so colour in the tree is reserved for git status (the earlier
 * per-type hues read as decorations; a gold-ish icon looked "modified").
 * Extend `BY_EXT` / `BY_NAME` as new types earn a distinct glyph; anything
 * unmapped falls back to a muted generic file.
 */

/** Exact-filename overrides (checked before the extension), lower-cased. */
const BY_NAME: Record<string, LucideIcon> = {
  'package.json': FileJson,
  'package-lock.json': FileLock,
  'pnpm-lock.yaml': FileLock,
  'yarn.lock': FileLock,
  'pnpm-workspace.yaml': FileCog,
  dockerfile: FileCode,
  '.gitignore': FileCog,
  '.gitattributes': FileCog,
  'readme.md': FileText,
  license: FileText,
  licence: FileText,
};

/** Extension → glyph. Lower-cased extension without the dot. */
const BY_EXT: Record<string, LucideIcon> = {
  // code
  ts: FileCode,
  tsx: FileCode,
  mts: FileCode,
  cts: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  py: FileCode,
  rs: FileCode,
  go: FileCode,
  rb: FileCode,
  php: FileCode,
  java: FileCode,
  kt: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  cc: FileCode,
  html: FileCode,
  htm: FileCode,
  xml: FileCode,
  vue: FileCode,
  sql: FileCode,
  // data / config
  json: FileJson,
  jsonc: FileJson,
  yml: FileCog,
  yaml: FileCog,
  toml: FileCog,
  ini: FileCog,
  cfg: FileCog,
  conf: FileCog,
  env: FileKey,
  lock: FileLock,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  xls: FileSpreadsheet,
  // docs
  md: FileText,
  mdx: FileText,
  markdown: FileText,
  txt: FileText,
  rtf: FileText,
  log: FileText,
  pdf: FileText,
  // styles
  css: FileType,
  scss: FileType,
  sass: FileType,
  less: FileType,
  // shell
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  fish: FileTerminal,
  // images
  svg: FileImage,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  bmp: FileImage,
  ico: FileImage,
  avif: FileImage,
  // media
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
  mkv: FileVideo,
  avi: FileVideo,
  mp3: FileAudio,
  wav: FileAudio,
  flac: FileAudio,
  ogg: FileAudio,
  m4a: FileAudio,
  // archives
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  tgz: FileArchive,
  rar: FileArchive,
  '7z': FileArchive,
};

/** Whether a filename has a curated glyph (exact name first, then extension). */
function fileIcon(name: string): { Icon: LucideIcon; generic: boolean } {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return { Icon: byName, generic: false };
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const byExt = BY_EXT[lower.slice(dot + 1)];
    if (byExt) return { Icon: byExt, generic: false };
  }
  return { Icon: File, generic: true };
}

/** The file-type glyph for a tree row. `dimmed` greys it (git-ignored files). */
export function FileTypeIcon({ name, dimmed }: { name: string; dimmed?: boolean }) {
  const { Icon, generic } = fileIcon(name);
  return (
    <Icon className={cn('size-3.5 shrink-0', dimmed || generic ? 'text-fg-muted' : 'text-fg')} />
  );
}
