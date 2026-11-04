import { lstatSync } from 'node:fs';
import type { HostRemovalServiceReview } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import { supervisorCommand } from '../../services.js';
import { syncServiceDefinitionDirectory } from '../../supervision/definition-directory.js';
import { serviceIsStopped } from '../../supervision/stopped.js';
import { inspectSystemdProperties, systemdServiceProperties } from '../../supervision/systemd.js';
import { HostRemovalGuard } from '../guard.js';
import {
  removalProcessEnded,
  requireRemovalAuthority,
  requireRemovalTarget,
  verifyRemovalServiceStopped,
  verifyRemovalServiceUnregistered,
} from '../services.js';
import { removeReviewedServiceDefinition } from './definition.js';

export type UnregistrationStep = 'disable' | 'reset' | 'delete' | 'reload';

/** Existing service checks with separate durable intent for each independently observable effect. */
export class RemovalUnregistrationSteps {
  constructor(
    private readonly guard: HostRemovalGuard,
    private readonly review: HostRemovalServiceReview,
    private readonly authorised: () => boolean,
    private readonly run?: CompilationCommandRunner,
  ) {}

  private requireCurrent(): void {
    this.guard.requireController();
    requireRemovalAuthority(this.guard, this.authorised);
    requireRemovalTarget(this.review.target);
  }

  private async stopped(): Promise<void> {
    this.requireCurrent();
    await verifyRemovalServiceStopped(this.guard, this.review, this.authorised, this.run);
    this.requireCurrent();
  }

  private async disabled(): Promise<void> {
    if (this.review.target.kind !== 'systemd') return;
    const result = await supervisorCommand(this.guard.home, this.guard.commands(this.run))(
      'systemctl',
      ['--user', 'show', '--property=UnitFileState', '--value', this.review.target.name],
    );
    if (result.stdout.trim() !== 'disabled') throw new Error('Service disablement is unconfirmed');
    this.requireCurrent();
  }

  private async reset(): Promise<void> {
    await this.stopped();
    await this.disabled();
    if (
      !(await serviceIsStopped(this.guard.home, this.review.target, this.guard.commands(this.run)))
    )
      throw new Error('Failed host service was not reset');
    this.requireCurrent();
  }

  private absent(): void {
    try {
      lstatSync(this.review.definition);
      throw new Error('Host service definition remains after deletion');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Deleting a loaded unit can require reload; that state is expected only at this boundary. */
  private async deleted(): Promise<void> {
    this.requireCurrent();
    this.absent();
    const run = this.guard.commands(this.run);
    if (this.review.target.kind === 'systemd') {
      const values = await inspectSystemdProperties(
        this.guard.home,
        this.review.target,
        systemdServiceProperties,
        run,
        true,
      );
      // NeedDaemonReload describes changed source files, not process liveness:
      // https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html
      if (
        !values ||
        values.get('Id') !== this.review.target.name ||
        !['loaded', 'not-found'].includes(values.get('LoadState')!) ||
        values.get('ActiveState') !== 'inactive' ||
        values.get('SubState') !== 'dead' ||
        values.get('MainPID') !== '0' ||
        !['yes', 'no'].includes(values.get('NeedDaemonReload')!)
      )
        throw new Error('Service shutdown after definition deletion is unconfirmed');
    } else if (!(await serviceIsStopped(this.guard.home, this.review.target, run)))
      throw new Error('Service shutdown after definition deletion is unconfirmed');
    if (!removalProcessEnded(this.review))
      throw new Error('Outgoing service process remains alive');
    this.requireCurrent();
    this.absent();
    syncServiceDefinitionDirectory(this.review.definition);
  }

  async verify(step: UnregistrationStep): Promise<void> {
    this.requireCurrent();
    if (step === 'disable') {
      await this.stopped();
      await this.disabled();
    } else if (step === 'reset') await this.reset();
    else if (step === 'delete') await this.deleted();
    else {
      await this.deleted();
      await verifyRemovalServiceUnregistered(this.guard, this.review, this.authorised, this.run);
    }
    this.requireCurrent();
  }

  async execute(step: UnregistrationStep): Promise<void> {
    this.requireCurrent();
    const execute = supervisorCommand(this.guard.home, this.guard.commands(this.run));
    if (step === 'disable') {
      await this.stopped();
      await execute('systemctl', ['--user', 'disable', this.review.target.name]);
    } else if (step === 'reset') {
      await this.stopped();
      await this.disabled();
      if (
        !(await serviceIsStopped(
          this.guard.home,
          this.review.target,
          this.guard.commands(this.run),
        ))
      ) {
        this.requireCurrent();
        await execute('systemctl', ['--user', 'reset-failed', this.review.target.name]);
      }
    } else if (step === 'delete') {
      await this.reset();
      removeReviewedServiceDefinition(this.review, () => this.requireCurrent());
    } else {
      await this.deleted();
      await execute('systemctl', ['--user', 'daemon-reload']);
    }
    await this.verify(step);
  }
}
