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
 * A curated, self-contained file-type icon theme (SPEC §8) — the explorer's
 * colourful per-extension glyphs, matching the VSCode feel without pulling a
 * heavy third-party asset bundle. Icons are lucide (already a dependency);
 * their hues come from the `text-icon-*` utilities, which resolve to the
 * theme-aware ANSI ramp in tokens.css (SPEC §12) — this file adds no raw
 * colours. Extend `BY_EXT` / `BY_NAME` as new types earn a distinct glyph;
 * anything unmapped falls back to a muted generic file.
 */

interface IconSpec {
  Icon: LucideIcon;
  colour: string;
}

const GENERIC: IconSpec = { Icon: File, colour: 'text-fg-muted' };

/** Exact-filename overrides (checked before the extension), lower-cased. */
const BY_NAME: Record<string, IconSpec> = {
  'package.json': { Icon: FileJson, colour: 'text-icon-green' },
  'package-lock.json': { Icon: FileLock, colour: 'text-fg-muted' },
  'pnpm-lock.yaml': { Icon: FileLock, colour: 'text-fg-muted' },
  'yarn.lock': { Icon: FileLock, colour: 'text-fg-muted' },
  'pnpm-workspace.yaml': { Icon: FileCog, colour: 'text-icon-amber' },
  dockerfile: { Icon: FileCode, colour: 'text-icon-cyan' },
  '.gitignore': { Icon: FileCog, colour: 'text-icon-amber' },
  '.gitattributes': { Icon: FileCog, colour: 'text-icon-amber' },
  'readme.md': { Icon: FileText, colour: 'text-icon-blue' },
  license: { Icon: FileText, colour: 'text-icon-amber' },
  licence: { Icon: FileText, colour: 'text-icon-amber' },
};

/** Extension → icon + hue. Lower-cased extension without the dot. */
const BY_EXT: Record<string, IconSpec> = {
  // code
  ts: { Icon: FileCode, colour: 'text-icon-blue' },
  tsx: { Icon: FileCode, colour: 'text-icon-blue' },
  mts: { Icon: FileCode, colour: 'text-icon-blue' },
  cts: { Icon: FileCode, colour: 'text-icon-blue' },
  js: { Icon: FileCode, colour: 'text-icon-amber' },
  jsx: { Icon: FileCode, colour: 'text-icon-amber' },
  mjs: { Icon: FileCode, colour: 'text-icon-amber' },
  cjs: { Icon: FileCode, colour: 'text-icon-amber' },
  py: { Icon: FileCode, colour: 'text-icon-blue' },
  rs: { Icon: FileCode, colour: 'text-icon-red' },
  go: { Icon: FileCode, colour: 'text-icon-cyan' },
  rb: { Icon: FileCode, colour: 'text-icon-red' },
  php: { Icon: FileCode, colour: 'text-icon-violet' },
  java: { Icon: FileCode, colour: 'text-icon-red' },
  kt: { Icon: FileCode, colour: 'text-icon-violet' },
  c: { Icon: FileCode, colour: 'text-icon-blue' },
  h: { Icon: FileCode, colour: 'text-icon-blue' },
  cpp: { Icon: FileCode, colour: 'text-icon-blue' },
  hpp: { Icon: FileCode, colour: 'text-icon-blue' },
  cc: { Icon: FileCode, colour: 'text-icon-blue' },
  html: { Icon: FileCode, colour: 'text-icon-red' },
  htm: { Icon: FileCode, colour: 'text-icon-red' },
  xml: { Icon: FileCode, colour: 'text-icon-amber' },
  vue: { Icon: FileCode, colour: 'text-icon-green' },
  // data / config
  json: { Icon: FileJson, colour: 'text-icon-amber' },
  jsonc: { Icon: FileJson, colour: 'text-icon-amber' },
  yml: { Icon: FileCog, colour: 'text-icon-violet' },
  yaml: { Icon: FileCog, colour: 'text-icon-violet' },
  toml: { Icon: FileCog, colour: 'text-fg-muted' },
  ini: { Icon: FileCog, colour: 'text-fg-muted' },
  cfg: { Icon: FileCog, colour: 'text-fg-muted' },
  conf: { Icon: FileCog, colour: 'text-fg-muted' },
  env: { Icon: FileKey, colour: 'text-icon-amber' },
  lock: { Icon: FileLock, colour: 'text-fg-muted' },
  sql: { Icon: FileCode, colour: 'text-icon-cyan' },
  csv: { Icon: FileSpreadsheet, colour: 'text-icon-green' },
  tsv: { Icon: FileSpreadsheet, colour: 'text-icon-green' },
  xlsx: { Icon: FileSpreadsheet, colour: 'text-icon-green' },
  xls: { Icon: FileSpreadsheet, colour: 'text-icon-green' },
  // docs
  md: { Icon: FileText, colour: 'text-icon-blue' },
  mdx: { Icon: FileText, colour: 'text-icon-blue' },
  markdown: { Icon: FileText, colour: 'text-icon-blue' },
  txt: { Icon: FileText, colour: 'text-fg-muted' },
  rtf: { Icon: FileText, colour: 'text-fg-muted' },
  log: { Icon: FileText, colour: 'text-fg-muted' },
  pdf: { Icon: FileText, colour: 'text-icon-red' },
  // styles
  css: { Icon: FileType, colour: 'text-icon-cyan' },
  scss: { Icon: FileType, colour: 'text-icon-cyan' },
  sass: { Icon: FileType, colour: 'text-icon-cyan' },
  less: { Icon: FileType, colour: 'text-icon-cyan' },
  // shell
  sh: { Icon: FileTerminal, colour: 'text-icon-green' },
  bash: { Icon: FileTerminal, colour: 'text-icon-green' },
  zsh: { Icon: FileTerminal, colour: 'text-icon-green' },
  fish: { Icon: FileTerminal, colour: 'text-icon-green' },
  // images
  svg: { Icon: FileImage, colour: 'text-icon-amber' },
  png: { Icon: FileImage, colour: 'text-icon-violet' },
  jpg: { Icon: FileImage, colour: 'text-icon-violet' },
  jpeg: { Icon: FileImage, colour: 'text-icon-violet' },
  gif: { Icon: FileImage, colour: 'text-icon-violet' },
  webp: { Icon: FileImage, colour: 'text-icon-violet' },
  bmp: { Icon: FileImage, colour: 'text-icon-violet' },
  ico: { Icon: FileImage, colour: 'text-icon-violet' },
  avif: { Icon: FileImage, colour: 'text-icon-violet' },
  // media
  mp4: { Icon: FileVideo, colour: 'text-icon-violet' },
  mov: { Icon: FileVideo, colour: 'text-icon-violet' },
  webm: { Icon: FileVideo, colour: 'text-icon-violet' },
  mkv: { Icon: FileVideo, colour: 'text-icon-violet' },
  avi: { Icon: FileVideo, colour: 'text-icon-violet' },
  mp3: { Icon: FileAudio, colour: 'text-icon-cyan' },
  wav: { Icon: FileAudio, colour: 'text-icon-cyan' },
  flac: { Icon: FileAudio, colour: 'text-icon-cyan' },
  ogg: { Icon: FileAudio, colour: 'text-icon-cyan' },
  m4a: { Icon: FileAudio, colour: 'text-icon-cyan' },
  // archives
  zip: { Icon: FileArchive, colour: 'text-fg-muted' },
  tar: { Icon: FileArchive, colour: 'text-fg-muted' },
  gz: { Icon: FileArchive, colour: 'text-fg-muted' },
  tgz: { Icon: FileArchive, colour: 'text-fg-muted' },
  rar: { Icon: FileArchive, colour: 'text-fg-muted' },
  '7z': { Icon: FileArchive, colour: 'text-fg-muted' },
};

/** Resolve a filename to its icon + hue (exact name first, then extension). */
export function fileIconSpec(name: string): IconSpec {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    const byExt = BY_EXT[ext];
    if (byExt) return byExt;
  }
  return GENERIC;
}

/** The coloured file-type glyph for a tree row. `dimmed` greys it (git-ignored files). */
export function FileTypeIcon({ name, dimmed }: { name: string; dimmed?: boolean }) {
  const { Icon, colour } = fileIconSpec(name);
  return <Icon className={cn('size-3.5 shrink-0', dimmed ? 'text-fg-muted' : colour)} />;
}
