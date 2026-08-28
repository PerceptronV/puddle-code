import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { LATEX_TOOLS, type LatexToolchain } from './toolchain.js';

/** Re-check occasionally so installing TeX does not require a daemon restart. */
const CACHE_TTL_MS = 30_000;

interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
}

let cached: { key: string; at: number; toolchain: LatexToolchain } | null = null;

/** Drop process-wide discovery state (tests and future live PATH changes). */
export function clearLatexDiscoveryCache(): void {
  cached = null;
}

/**
 * Locate a broad Unix TeX installation without invoking a shell. PATH remains
 * authoritative, followed by well-known TeX Live, MacTeX, TinyTeX and MiKTeX
 * roots. Puddle's supported daemon hosts are macOS and Linux (including WSL).
 */
export function discoverLatexToolchain(options: DiscoveryOptions = {}): LatexToolchain {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const now = (options.now ?? Date.now)();
  const key = `${platform}\0${home}\0${env.PATH ?? ''}\0${env.TEXBIN ?? ''}`;
  if (cached && cached.key === key && now - cached.at < CACHE_TTL_MS) return cached.toolchain;

  const dirs = candidateDirectories(env, home, platform);
  const paths: LatexToolchain['paths'] = {};
  for (const tool of LATEX_TOOLS) {
    for (const dir of dirs) {
      const candidate = join(dir, tool);
      if (!isExecutableFile(candidate)) continue;
      paths[tool] = candidate;
      break;
    }
  }
  const toolchain = { paths, searchPath: dirs.join(delimiter) };
  cached = { key, at: now, toolchain };
  return toolchain;
}

function candidateDirectories(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): string[] {
  const dirs = new Set<string>();
  for (const dir of (env.PATH ?? '').split(delimiter)) if (dir) dirs.add(dir);
  for (const dir of [env.TEXBIN, env.MIKTEX_HOME, env.TEXLIVE_HOME]) if (dir) dirs.add(dir);

  if (platform === 'darwin') {
    dirs.add('/Library/TeX/texbin');
    dirs.add('/Applications/MiKTeX Console.app/Contents/bin');
    addArchitectureDirs(dirs, join(home, 'Library', 'TinyTeX', 'bin'), platform);
    addArchitectureDirs(dirs, join(home, '.TinyTeX', 'bin'), platform);
  } else {
    // Distribution packages normally use these even when a supervisor gives
    // puddled a deliberately short PATH.
    dirs.add('/usr/bin');
    dirs.add('/usr/local/bin');
    addArchitectureDirs(dirs, join(home, '.TinyTeX', 'bin'), platform);
  }

  addVersionedTeXLiveDirs(dirs, '/usr/local/texlive', platform);
  addVersionedTeXLiveDirs(dirs, join(home, 'texlive'), platform);
  for (const root of [
    join(home, '.miktex', 'texmfs', 'install', 'miktex', 'bin'),
    '/usr/local/share/miktex-texmf/miktex/bin',
  ]) {
    dirs.add(root);
    addArchitectureDirs(dirs, root, platform);
  }
  return [...dirs];
}

/** Add immediate children such as `universal-darwin` or `x86_64-linux`. */
function addArchitectureDirs(dirs: Set<string>, binRoot: string, platform: NodeJS.Platform): void {
  dirs.add(binRoot);
  for (const entry of safeDirectories(binRoot)) {
    if (entry.includes('darwin') && platform !== 'darwin') continue;
    if (entry.includes('linux') && platform !== 'linux') continue;
    dirs.add(join(binRoot, entry));
  }
}

/** Add `<year>/bin/<architecture>` without an unbounded filesystem walk. */
function addVersionedTeXLiveDirs(dirs: Set<string>, root: string, platform: NodeJS.Platform): void {
  for (const version of safeDirectories(root)) {
    const bin = join(root, version, 'bin');
    addArchitectureDirs(dirs, bin, platform);
  }
}

function safeDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
