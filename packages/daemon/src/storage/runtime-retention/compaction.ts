import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { compatibleRuntimeProtocol, runtimeIdentitySchema } from '@puddle/shared';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import { CollectionBudget } from '../../host/installation/collection/budget.js';
import { acquireRuntimeRetirementClaims } from '../../host/installation/collection/retirement/claims.js';
import { runtimeReleaseRetired } from '../../host/installation/collection/retirement/runtimes.js';
import { TerminalLogCompactor } from '../../logs/retention/compactor.js';
import { runtimeStorageCategory } from './paths.js';

const PROOF_FILES = [
  'launch.json',
  'retired.json',
  'assets.json',
  'supervisor.json',
  'release-retirement.json',
];
const REPLAY_BYTES = 256 * 1024;

/** File identities freeze an already validated receipt; these stamps alone prove nothing. */
function proofStamp(directory: string): string {
  return JSON.stringify(
    ['', ...PROOF_FILES].map((name) => {
      try {
        const stat = lstatSync(join(directory, name));
        if (stat.isSymbolicLink() || (name ? !stat.isFile() : !stat.isDirectory()))
          throw new Error('Runtime retirement path changed');
        return [
          name,
          stat.dev,
          stat.ino,
          stat.size,
          stat.mode,
          stat.uid,
          stat.mtimeMs,
          stat.ctimeMs,
        ];
      } catch (error) {
        if (name && (error as NodeJS.ErrnoException).code === 'ENOENT') return [name, null];
        throw error;
      }
    }),
  );
}

interface Dependencies {
  home: string;
  runtimes: Pick<RuntimeStore, 'get' | 'releaseReferences'>;
  retentionDays(): number;
  onError?(error: unknown): void;
}

/** One cursor on the existing host maintenance schedule, never an owner-side sweeper. */
export class RuntimeLogRetention {
  private after = '';
  private current: string | null = null;
  private compactor: TerminalLogCompactor | null = null;
  private closed = false;

  constructor(private readonly deps: Dependencies) {}

  private async next(): Promise<void> {
    await this.compactor?.close();
    this.compactor = null;
    if (this.current) this.after = this.current;
    this.current = null;
  }

  /** The caller holds daemon pause and collection exclusion for this complete slice. */
  async sweep(
    requireCurrent: () => void,
    deadline: number,
    budget: CollectionBudget,
  ): Promise<boolean> {
    if (this.closed) return false;
    const retentionDays = this.deps.retentionDays();
    if (retentionDays === 0) {
      await this.next();
      return false;
    }
    for (let owners = 0; owners < 8 && !this.closed && performance.now() < deadline; owners++) {
      requireCurrent();
      if (!this.current) {
        const [row] = this.deps.runtimes.releaseReferences(this.after, 1);
        if (!row) {
          this.after = '';
          return false;
        }
        runtimeIdentitySchema.shape.runtime_id.parse(row.runtime_id);
        if (row.runtime_id <= this.after) throw new Error('Runtime history inventory is unordered');
        this.current = row.runtime_id;
      }
      const id = this.current;
      let claims: ReturnType<typeof acquireRuntimeRetirementClaims> | undefined;
      try {
        claims = acquireRuntimeRetirementClaims(this.deps.home, id);
        requireCurrent();
        const binding = this.deps.runtimes.get(id);
        if (!binding) throw new Error('Runtime history binding disappeared');
        if (
          binding.runtime_id !== id ||
          !compatibleRuntimeProtocol({
            major: binding.protocol_major,
            minor: binding.protocol_minor,
          })
        )
          throw new Error('Runtime history identity or protocol is unknown');
        const directory = join(this.deps.home, 'runtimes', id);
        const before = proofStamp(directory);
        if (!runtimeReleaseRetired(this.deps.home, binding, budget)) {
          await this.next();
          continue;
        }
        const frozen = JSON.stringify(binding);
        const isBusy = (stream: string, term: string) => {
          requireCurrent();
          return (
            this.closed ||
            JSON.stringify(this.deps.runtimes.get(id)) !== frozen ||
            proofStamp(directory) !== before ||
            runtimeStorageCategory(`logs/${stream}/${term}.log`, false) !== 'rawLogs'
          );
        };
        // Reject evidence changed during its initial read before opening any history file.
        if (proofStamp(directory) !== before)
          throw new Error('Runtime retirement evidence changed');
        this.compactor ??= new TerminalLogCompactor();
        const result = await this.compactor.sweep({
          logsDir: join(directory, 'logs'),
          retentionDays,
          replayBytes: REPLAY_BYTES,
          isBusy,
          stopped: () => this.closed,
          deadline,
        });
        if (!result.complete) return true;
        await this.next();
      } catch (error) {
        this.deps.onError?.(error);
        await this.next();
      } finally {
        claims?.release();
      }
    }
    return !this.closed;
  }

  /** The maintenance owner drains its active pass before closing this cursor. */
  async close(): Promise<void> {
    this.closed = true;
    await this.next();
  }
}
