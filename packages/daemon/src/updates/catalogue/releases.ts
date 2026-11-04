import { join } from 'node:path';
import { z } from 'zod';
import { hostReleaseCheckSchema, type HostReleaseCheck } from '@puddle/shared';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { latestGitHubRelease, releaseRepository } from '@puddle/shared/node/host-control';

export const HOST_RELEASE_CHECK_MS = 30 * 60_000;
const stored = z.object({ format: z.literal(1), check: hostReleaseCheckSchema }).strict();

/** One lazy, coalesced release poller per daemon; never stages or activates software. */
export class HostReleaseChecks {
  private check: HostReleaseCheck;
  private pending: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly abort = new AbortController();
  private closed = false;
  private started = false;
  private readonly file: string;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      home: string;
      changed(): void;
      repository?: string | null;
      fetchFn?: typeof fetch;
      platform?: NodeJS.Platform;
      arch?: string;
      now?: () => number;
    },
  ) {
    this.file = join(options.home, 'updates/release-check.json');
    this.now = options.now ?? Date.now;
    const repository = options.repository === undefined ? releaseRepository() : options.repository;
    this.check = hostReleaseCheckSchema.parse({
      repository: repository ?? null,
      state: repository ? 'failed' : 'unconfigured',
      checked_at: null,
      succeeded_at: null,
      latest: null,
    });
    if (!repository) return;
    try {
      const { check } = stored.parse(readPrivateJson(this.file, 16 * 1024));
      if (
        check.repository === repository &&
        check.checked_at !== null &&
        (check.succeeded_at === null || check.succeeded_at <= check.checked_at)
      )
        this.check = { ...check, state: check.state === 'ready' ? 'ready' : 'failed' };
    } catch {
      /* A missing/invalid cache cannot establish that the host is current. */
    }
  }

  read(): HostReleaseCheck {
    if (!this.started && !this.closed) {
      this.started = true;
      void this.refresh();
    }
    return hostReleaseCheckSchema.parse(this.check);
  }

  refresh(): Promise<void> {
    if (this.closed || !this.check.repository) return Promise.resolve();
    if (this.pending) return this.pending;
    const age = this.check.checked_at === null ? Infinity : this.now() - this.check.checked_at;
    if (age >= 0 && age < HOST_RELEASE_CHECK_MS) {
      this.schedule();
      return Promise.resolve();
    }
    this.check = { ...this.check, state: 'checking', checked_at: this.now() };
    this.persist(); // A daemon replacement also observes the attempt's cadence.
    const repository = this.check.repository!;
    this.pending = (async () => {
      try {
        const release = await latestGitHubRelease(repository, {
          fetchFn: this.options.fetchFn,
          signal: this.abort.signal,
        });
        if (this.closed) return;
        const platform = this.options.platform ?? process.platform;
        const arch = this.options.arch ?? process.arch;
        const file = `puddled-v${release.version}-${platform}-${arch}.tar.gz`;
        const host_asset =
          ['linux', 'darwin'].includes(platform) &&
          ['arm64', 'x64'].includes(arch) &&
          release.assets.some((asset) => asset.name === file) &&
          release.assets.some((asset) => asset.name === 'SHA256SUMS');
        this.check = {
          ...this.check,
          state: 'ready',
          succeeded_at: this.check.checked_at,
          latest: { version: release.version, host_asset },
        };
      } catch {
        if (this.closed) return;
        this.check = { ...this.check, state: 'failed' };
      } finally {
        this.pending = undefined;
        if (!this.closed) {
          this.persist();
          this.schedule();
          this.notify();
        }
      }
    })();
    this.notify();
    return this.pending;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.abort.abort();
  }

  private persist(): void {
    try {
      atomicPrivateJson(this.file, { format: 1, check: this.check });
    } catch {
      /* Cache failures must not interrupt PTYs or connecting windows. */
    }
  }

  private notify(): void {
    try {
      this.options.changed();
    } catch {
      /* A lost viewer cannot fail discovery; the next status read includes this state. */
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.closed || !this.check.repository) return;
    const age =
      this.check.checked_at === null ? HOST_RELEASE_CHECK_MS : this.now() - this.check.checked_at;
    this.timer = setTimeout(
      () => {
        void this.refresh();
      },
      Math.max(1, HOST_RELEASE_CHECK_MS - Math.max(0, age)),
    );
    this.timer.unref();
  }
}
