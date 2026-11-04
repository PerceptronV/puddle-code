import { lstatSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HOST_REMOVAL_SERVICES_BYTES,
  hostRemovalRestoreSchema,
  hostRemovalRestorePlan,
  hostRemovalServicesSchema,
  type HostRemovalRestore,
  type HostRemovalRestoreAction,
  type HostRemovalServices,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  digest,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import { HostActionWriter } from '../../installation/action-writer.js';
import { supervisorCommand } from '../../services.js';
import { readOwnedServiceDefinition } from '../../supervision/definition.js';
import { HostRemovalGuard } from '../guard.js';
import { HostRemovalServiceOperation } from '../operations/services.js';
import { verifyRemovalServiceStopped, verifyRemovalServiceUnregistered } from '../services.js';
import { restoreServiceDefinition, syncRestoredServiceDefinition } from './definition.js';

interface Options {
  authorised: () => boolean;
  run?: CompilationCommandRunner;
  userHome?: string;
  write?: typeof atomicPrivateJson;
  /** Continuation must find the existing exact journal; absence is never a fresh attempt. */
  resume?: boolean;
}

/** Restore the retained service configuration; ordinary selected startup follows after hand-off. */
export class HostRemovalServiceRestore {
  private readonly removal: HostRemovalServices;
  private readonly fingerprint: string;
  private readonly writer: HostActionWriter<HostRemovalRestoreAction, HostRemovalRestore>;
  private readonly directory: string;

  constructor(
    private readonly guard: HostRemovalGuard,
    private readonly operation: HostRemovalServiceOperation,
    private readonly options: Options,
  ) {
    guard.requireController();
    this.removal = operation.read();
    if (this.removal.actions.some(({ state }) => state !== 'finished'))
      throw new Error('Complete removal recovery before restoring services');
    this.fingerprint = digest(JSON.stringify(this.removal));
    this.directory = join(guard.home, 'installation/removal');
    this.requireCurrent();
    for (const { review } of this.removal.services) {
      const expected =
        review.target.kind === 'systemd'
          ? join(options.userHome ?? homedir(), '.config/systemd/user', review.target.name)
          : join(
              options.userHome ?? homedir(),
              'Library/LaunchAgents',
              `${review.target.name}.plist`,
            );
      if (review.definition !== expected)
        throw new Error('Restoration definition is outside its installed user path');
    }
    const initial = hostRemovalRestoreSchema.parse({
      format: 1,
      removal_id: this.removal.id,
      removal_digest: this.fingerprint,
      actions: hostRemovalRestorePlan(this.removal).map((action) => ({ action, state: 'planned' })),
    });
    const path = join(this.directory, 'restore.json');
    let previous: HostRemovalRestore | null = null;
    try {
      previous = hostRemovalRestoreSchema.parse(readPrivateJson(path, 4096));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const resume = previous?.removal_id === this.removal.id;
    if (options.resume && !resume)
      throw new Error('Missing exact restoration journal for continuation');
    if (resume && !options.resume) throw new Error('Service restoration was already recorded');
    if (previous && !resume) {
      const restored = hostRemovalServicesSchema.parse(
        readPrivateJson(
          join(this.directory, 'restored-services.json'),
          HOST_REMOVAL_SERVICES_BYTES,
        ),
      );
      if (
        previous.removal_id !== restored.id ||
        previous.removal_digest !== digest(JSON.stringify(restored)) ||
        previous.actions.some(({ state }) => state !== 'finished') ||
        restored.actions.some(({ state }) => state !== 'finished')
      )
        throw new Error('Previous restoration is unresolved');
      try {
        const archive = hostRemovalRestoreSchema.parse(
          readPrivateJson(join(this.directory, 'previous-restore.json'), 4096),
        );
        if (archive.actions.some(({ state }) => state !== 'finished'))
          throw new Error('Historical restoration is unresolved');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      renameSync(path, join(this.directory, 'previous-restore.json'));
      syncPrivateDirectory(this.directory);
    }
    this.writer = new HostActionWriter({
      path,
      initial,
      parse: hostRemovalRestoreSchema.parse,
      maxBytes: 4096,
      requireCurrent: () => this.requireCurrent(),
      resume,
      write: options.write,
    });
  }

  private requireCurrent(): void {
    this.guard.requireController();
    if (!this.options.authorised()) throw new Error('Host restoration authority expired');
    if (digest(JSON.stringify(this.operation.read())) !== this.fingerprint)
      throw new Error('Removal evidence changed before restoration');
  }

  private entry(component: 'daemon' | 'connector') {
    const entry = this.removal.services.find(({ review }) => review.component === component);
    if (!entry) throw new Error('Missing reviewed service for restoration');
    return entry;
  }

  private async verifySource(component: 'daemon' | 'connector'): Promise<void> {
    const { review, source } = this.entry(component);
    if (
      (await readOwnedServiceDefinition(review.definition)) !== source ||
      lstatSync(review.definition).nlink !== 1
    )
      throw new Error('Restored service definition changed');
    syncRestoredServiceDefinition(review.definition);
    this.requireCurrent();
  }

  private async verify(action: HostRemovalRestoreAction): Promise<void> {
    this.requireCurrent();
    if (action === 'reload-services') {
      for (const { review } of this.removal.services)
        await verifyRemovalServiceStopped(
          this.guard,
          review,
          this.options.authorised,
          this.options.run,
        );
    } else {
      const component = action.endsWith('-connector') ? 'connector' : 'daemon';
      await this.verifySource(component);
      if (action.startsWith('enable-')) {
        // UnitFileState is the manager's install-state property (systemd 254).
        // https://www.freedesktop.org/software/systemd/man/254/org.freedesktop.systemd1.html
        const result = await supervisorCommand(
          this.guard.home,
          this.guard.commands(this.options.run),
        )('systemctl', [
          '--user',
          'show',
          '--property=UnitFileState',
          '--value',
          this.entry(component).review.target.name,
        ]);
        if (result.stdout.trim() !== 'enabled')
          throw new Error('Restored service enablement is unconfirmed');
      }
    }
    this.requireCurrent();
  }

  /** Consumed commands are inspection-only, including after a lost completion write. */
  async restore(): Promise<void> {
    for (const step of this.writer.read().actions) {
      if (step.state !== 'planned') {
        await this.writer.observe(step.action, () => this.verify(step.action));
        continue;
      }
      await this.writer.run(step.action, async () => {
        const execute = supervisorCommand(this.guard.home, this.guard.commands(this.options.run));
        if (step.action === 'reload-services')
          await execute('systemctl', ['--user', 'daemon-reload']);
        else {
          const component = step.action.endsWith('-connector') ? 'connector' : 'daemon';
          const { review, source } = this.entry(component);
          if (step.action.startsWith('restore-')) {
            await verifyRemovalServiceUnregistered(
              this.guard,
              review,
              this.options.authorised,
              this.options.run,
            );
            this.requireCurrent();
            restoreServiceDefinition(review.definition, source);
          } else {
            await this.verifySource(component);
            this.requireCurrent();
            // No --now: enabling restores installation links without starting the service.
            // https://www.freedesktop.org/software/systemd/man/254/systemctl.html#enable%20UNIT%E2%80%A6
            await execute('systemctl', ['--user', 'enable', review.target.name]);
          }
        }
        await this.verify(step.action);
      });
    }
  }

  /** Clear the removal fence only after fresh configuration and stopped-service verification. */
  async handoff(): Promise<void> {
    this.requireCurrent();
    const journal = this.writer.read();
    if (journal.actions.some(({ state }) => state !== 'finished'))
      throw new Error('Service restoration is incomplete');
    for (const { action } of journal.actions) await this.verify(action);
    for (const { review } of this.removal.services)
      await verifyRemovalServiceStopped(
        this.guard,
        review,
        this.options.authorised,
        this.options.run,
      );
    const destination = join(this.directory, 'restored-services.json');
    try {
      const previous = hostRemovalServicesSchema.parse(
        readPrivateJson(destination, HOST_REMOVAL_SERVICES_BYTES),
      );
      if (previous.actions.some(({ state }) => state !== 'finished'))
        throw new Error('Previous restored removal is incomplete');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.requireCurrent();
    renameSync(join(this.directory, 'services.json'), destination);
    syncPrivateDirectory(dirname(destination));
  }
}
