import { componentReleaseAt } from '@puddle/shared/node/host-control';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPaths } from '../paths.js';
import type { Transport } from '../transport/transport.js';
import { CliError, type Logger, silentLogger } from '../types.js';
import { pinnedHostVersion, repoSlug } from '../version.js';
import {
  parseHostReleaseVersion,
  parseLegacyHostVersion,
  releaseRepositorySchema,
} from '@puddle/shared';

export type HostComponent = 'daemon' | 'runtime';

export interface BootstrapOptions {
  /** Host release to install; defaults to the CLI's own version train. */
  version?: string;
  /** Local tarball path or URL (dev override / air-gapped hosts). */
  tarball?: string;
  /** Trusted host catalogue source; browser input must never supply this field. */
  repository?: string;
  logger?: Logger;
}

/**
 * The selected host component version under ~/.puddle/bin, read from release metadata
 * (or a legacy fixed-version selector) — never by executing an unknown
 * `puddled` (a pre-Phase-6 binary would START a daemon on --version).
 * Null when nothing bootstrap-managed is installed.
 */
export async function installedVersion(
  transport: Transport,
  component: HostComponent = 'daemon',
): Promise<string | null> {
  const current =
    component === 'runtime' ? `${hostPaths.home}/bin/runtime-current` : hostPaths.current;
  const metadata = await transport.exec(
    `if [ -e ${current}/VERSION ]; then head -c 130 ${current}/VERSION; else exit 3; fi`,
    { timeoutMs: 15_000 },
  );
  if (metadata.code === 0) return parseHostReleaseVersion(metadata.stdout) ?? null;
  if (metadata.code !== 3 || component === 'runtime') return null;
  const result = await transport.exec(`readlink ${hostPaths.current}`, { timeoutMs: 15_000 });
  if (result.code !== 0) return null;
  return parseLegacyHostVersion(result.stdout) ?? null;
}

/**
 * Install or upgrade the daemon by piping the embedded install.sh over the
 * transport — the exact script this CLI shipped with, so bootstrap logic has
 * one implementation (SPEC §10). A local --tarball is delivered to the host
 * cache first (scp over the master when remote).
 */
export async function installDaemon(
  transport: Transport,
  opts: BootstrapOptions = {},
): Promise<void> {
  return installHostComponent(transport, 'daemon', opts);
}

/** Shared host bootstrap; runtime selection never restarts the daemon or owners. */
export async function installHostComponent(
  transport: Transport,
  component: HostComponent,
  opts: BootstrapOptions = {},
): Promise<void> {
  await bootstrapHostComponent(transport, component, opts);
}

/** Shared delivery and release resolution for immediate installs and staged updates. */
export async function bootstrapHostComponent(
  transport: Transport,
  component: HostComponent,
  opts: BootstrapOptions = {},
  action: 'install' | 'stage' = 'install',
): Promise<string> {
  const logger = opts.logger ?? silentLogger;
  const version = opts.version ?? pinnedHostVersion(component);

  const args: string[] = ['--version', version, '--component', component];
  if (action === 'stage') args.push('--stage-only');
  if (opts.tarball !== undefined && !/^https?:\/\//.test(opts.tarball)) {
    if (!existsSync(opts.tarball)) {
      throw new CliError('not_installed', `tarball not found: ${opts.tarball}`);
    }
    if (transport.kind === 'local') {
      // The installer runs on this machine and can read the file in place.
      args.push('--tarball', resolve(opts.tarball));
      const localSums = `${opts.tarball}.sha256`;
      if (existsSync(localSums)) args.push('--sums', resolve(localSums));
    } else {
      const base = opts.tarball.split('/').pop() ?? 'puddled.tar.gz';
      // Home-relative on purpose: scp's sftp backend does no remote shell
      // expansion, and ssh exec's cwd is the home dir, so both resolve it.
      const destTarball = `.puddle/cache/${base}`;
      logger.info(`delivering ${base} to ${transport.label}`);
      await transport.copyTo(opts.tarball, destTarball);
      const sums = `${opts.tarball}.sha256`;
      if (existsSync(sums)) {
        await transport.copyTo(sums, `${destTarball}.sha256`);
        args.push('--tarball', destTarball, '--sums', `${destTarball}.sha256`);
      } else {
        args.push('--tarball', destTarball);
      }
    }
  } else {
    const slug =
      opts.repository === undefined ? repoSlug() : releaseRepositorySchema.parse(opts.repository);
    if (opts.tarball !== undefined) {
      // A URL tarball is fetched host-side by curl via --tarball? No: the
      // installer's --tarball takes a file path, so fetch-by-URL rides the
      // normal --repo path only. Reject to avoid a silent misread.
      throw new CliError('bad_arguments', '--tarball must be a local file path');
    }
    if (slug === undefined) {
      throw new CliError(
        'not_installed',
        'no release source is configured for this build',
        'pass --tarball <path> (pnpm build:tarball produces one) or set PUDDLE_REPO=owner/repo',
      );
    }
    if (action === 'install' && component === 'daemon') {
      const release = await componentReleaseAt(slug, 'daemon', version);
      const runtimeVersion = release.manifest.components.runtime;
      if (runtimeVersion !== version && (await installedVersion(transport, 'runtime')) === null)
        await bootstrapHostComponent(
          transport,
          'runtime',
          { ...opts, version: runtimeVersion, repository: slug },
          'install',
        );
    }
    args.push('--repo', slug);
  }

  logger.info(
    `${action === 'stage' ? 'staging' : 'installing'} ${component === 'daemon' ? 'puddled' : 'puddler'} ${version} on ${transport.label}`,
  );
  return runHostInstaller(transport, args, logger);
}

/** Execute the canonical embedded installer over the existing host transport. */
export async function runHostInstaller(
  transport: Transport,
  args: string[],
  logger: Logger = silentLogger,
): Promise<string> {
  const quoted = args.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
  const result = await transport.exec(`sh -s -- ${quoted}`, {
    stdin: readInstallScript(),
    timeoutMs: 10 * 60_000,
    onStdout: (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim() !== '') logger.info(line.trimEnd());
    },
  });
  if (result.code !== 0) {
    throw new CliError(
      'not_installed',
      `the installer failed on ${transport.label} (exit ${result.code})`,
      lastLines(result.stderr || result.stdout),
    );
  }
  return result.stdout;
}

function lastLines(text: string, count = 3): string {
  return text.trim().split('\n').slice(-count).join('\n');
}

/**
 * The canonical install.sh: dist builds ship it next to the bundle
 * (packages/cli/scripts/build.mjs copies it); dev runs (vitest over src)
 * read it from the repo.
 */
export function readInstallScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'install.sh'), // dist/index.js → dist/install.sh
    join(here, '..', '..', '..', '..', '..', 'scripts', 'install.sh'), // src/lib/installation/ → repo root
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new CliError('not_installed', 'install.sh is missing from this build');
}
