import { realpathSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HOST_REMOVAL_SERVICES_BYTES,
  hostRemovalUnregisterPlan,
  type HostRemovalServices as ServiceJournal,
  type HostRemovalServiceAction,
  type HostRemovalServiceReview,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  privateDirectory,
  privatePath,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import { validateHostRemovalServices as validate } from '@puddle/shared/node/host-control';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import { HostActionWriter } from '../../installation/action-writer.js';
import { readOwnedServiceDefinition } from '../../supervision/definition.js';
import { HostRemovalGuard } from '../guard.js';
import { RemovalUnregistrationSteps, type UnregistrationStep } from '../unregistration/steps.js';
import {
  stopRemovalService,
  unregisterRemovalService,
  verifyRemovalServiceStopped,
  verifyRemovalServiceUnregistered,
} from '../services.js';

type Component = HostRemovalServiceReview['component'];
interface Options {
  authorised: () => boolean;
  run?: CompilationCommandRunner;
  write?: typeof atomicPrivateJson;
  /** Public removal disables remote registrations before either service stops. */
  disableRemote?: boolean;
}

const file = (home: string) => join(home, 'installation/removal/services.json');

/** Service phase only. Runtime consent, remote disable and release collection belong to the caller. */
export class HostRemovalServiceOperation {
  private readonly writer: HostActionWriter<HostRemovalServiceAction, ServiceJournal>;

  private constructor(
    private readonly guard: HostRemovalGuard,
    private readonly journal: ServiceJournal,
    private readonly options: Options,
    resume: boolean,
  ) {
    this.requireCurrent();
    this.writer = new HostActionWriter({
      path: file(guard.home),
      initial: journal,
      parse: validate,
      maxBytes: HOST_REMOVAL_SERVICES_BYTES,
      resume,
      write: options.write,
      requireCurrent: (action) => {
        this.requireCurrent();
        if (action.startsWith('unregister-')) guard.requireController();
      },
    });
  }

  /** Record the exact sources before the first stop; never replace an existing attempt. */
  static async prepare(
    guard: HostRemovalGuard,
    reviews: HostRemovalServiceReview[],
    options: Options,
  ): Promise<HostRemovalServiceOperation> {
    guard.requireHeld();
    if (!options.authorised()) throw new Error('Host removal authority expired');
    const release = realpathSync(join(guard.home, 'bin/current'));
    const services: ServiceJournal['services'] = [];
    for (const review of reviews) {
      services.push({ review, source: await readOwnedServiceDefinition(review.definition) });
      guard.requireHeld();
      if (!options.authorised()) throw new Error('Host removal authority expired');
    }
    const components = ['connector', 'daemon'] as const;
    const present = components.filter((component) =>
      services.some(({ review }) => review.component === component),
    );
    const journal = validate({
      format: 1,
      id: randomUUID(),
      release_path: release,
      services,
      actions: [
        ...(options.disableRemote ? [{ action: 'disable-remote', state: 'planned' }] : []),
        ...present.map((component) => ({ action: `stop-${component}`, state: 'planned' })),
        ...present.flatMap((component) =>
          hostRemovalUnregisterPlan(
            services.find(({ review }) => review.component === component)!.review,
          ).map((action) => ({ action, state: 'planned' })),
        ),
      ],
    });
    privateDirectory(join(guard.home, 'installation'));
    syncPrivateDirectory(guard.home);
    privateDirectory(dirname(file(guard.home)));
    syncPrivateDirectory(join(guard.home, 'installation'));
    return new HostRemovalServiceOperation(guard, journal, options, false);
  }

  /** Trusted explicit continuation uses the existing record; missing evidence never creates a plan. */
  static open(guard: HostRemovalGuard, options: Options): HostRemovalServiceOperation {
    guard.requireHeld();
    privatePath(join(guard.home, 'installation'), true);
    privatePath(dirname(file(guard.home)), true);
    const journal = validate(readPrivateJson(file(guard.home), HOST_REMOVAL_SERVICES_BYTES));
    return new HostRemovalServiceOperation(guard, journal, options, true);
  }

  read(): ServiceJournal {
    this.requireCurrent();
    return this.writer.read();
  }

  async disableRemote(
    execute: () => Promise<void>,
    verify: () => Promise<void>,
    continuePending: () => Promise<void>,
  ): Promise<void> {
    const step = this.read().actions.find(({ action }) => action === 'disable-remote');
    if (!step) throw new Error('Removal has no accepted remote disable step');
    if (step.state !== 'planned') {
      // Disablement is a monotonic desired state while this removal fences
      // configuration. Explicit continuation reconciles only still-enabled profiles.
      if (step.state === 'started') await continuePending();
      return this.writer.observe('disable-remote', verify);
    }
    await this.writer.run('disable-remote', async () => {
      await execute();
      await verify();
    });
  }

  /** Before any intent only. Keep one private cancelled review without weakening active evidence. */
  cancel(): void {
    const journal = this.read();
    if (journal.actions.some(({ state }) => state !== 'planned'))
      throw new Error('An attempted host removal requires recovery, not cancellation');
    const cancelled = join(dirname(file(this.guard.home)), 'cancelled-services.json');
    try {
      const previous = validate(readPrivateJson(cancelled, HOST_REMOVAL_SERVICES_BYTES));
      if (previous.actions.some(({ state }) => state !== 'planned'))
        throw new Error('Cancelled removal record contains attempted work');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.requireCurrent();
    // Same-directory rename clears the active fence atomically; no service has been touched.
    renameSync(file(this.guard.home), cancelled);
    syncPrivateDirectory(dirname(cancelled));
  }

  private requireCurrent(): void {
    this.guard.requireHeld();
    if (!this.options.authorised()) throw new Error('Host removal authority expired');
    const release = realpathSync(join(this.guard.home, 'bin/current'));
    if (
      release !== this.journal.release_path ||
      dirname(release) !== realpathSync(join(this.guard.home, 'bin/versions'))
    )
      throw new Error('Selected daemon release changed during removal');
  }

  private review(component: Component) {
    const entry = this.journal.services.find(({ review }) => review.component === component);
    if (!entry) throw new Error('Service is not in the accepted removal inventory');
    return entry.review;
  }

  stop(component: Component): Promise<void> {
    return this.writer.run(`stop-${component}`, () =>
      stopRemovalService(
        this.guard,
        this.review(component),
        this.options.authorised,
        () => {},
        this.options.run,
      ),
    );
  }

  private unregistrationActions(component: Component): HostRemovalServiceAction[] {
    return this.journal.actions.some(({ action }) => action === `unregister-${component}`)
      ? [`unregister-${component}`]
      : hostRemovalUnregisterPlan(this.review(component));
  }

  unregistrationState(component: Component): 'planned' | 'started' | 'finished' {
    const actions = this.unregistrationActions(component);
    const states = this.read().actions.filter(({ action }) => actions.includes(action));
    if (states.every(({ state }) => state === 'finished')) return 'finished';
    return states.every(({ state }) => state === 'planned') ? 'planned' : 'started';
  }

  async unregister(component: Component): Promise<void> {
    if (this.unregistrationState(component) !== 'planned')
      throw new Error('Host action was already attempted');
    if (!this.journal.actions.some(({ action }) => action === `unregister-${component}`))
      return this.unregisterSteps(component, true);
    return this.writer.run(`unregister-${component}`, () =>
      unregisterRemovalService(
        this.guard,
        this.review(component),
        this.options.authorised,
        () => {},
        this.options.run,
      ),
    );
  }

  /** Explicit continuation can dispatch only still-planned substeps in the original exact plan. */
  async continueUnregistration(component: Component): Promise<void> {
    if (this.unregistrationState(component) === 'planned')
      throw new Error('No recorded unregistration attempt');
    if (this.journal.actions.some(({ action }) => action === `unregister-${component}`))
      return this.observe(component, 'unregister');
    return this.unregisterSteps(component, true);
  }

  private async unregisterSteps(component: Component, dispatch: boolean): Promise<void> {
    this.guard.requireController();
    const steps = new RemovalUnregistrationSteps(
      this.guard,
      this.review(component),
      this.options.authorised,
      this.options.run,
    );
    for (const action of this.unregistrationActions(component)) {
      const state = this.read().actions.find((entry) => entry.action === action)!.state;
      if (state === 'finished') continue;
      const step = action.split('-')[1] as UnregistrationStep;
      if (state === 'started') await this.writer.observe(action, () => steps.verify(step));
      else {
        if (!dispatch) throw new Error('Host action has no recorded attempt to observe');
        await this.writer.run(action, () => steps.execute(step));
      }
    }
    await verifyRemovalServiceUnregistered(
      this.guard,
      this.review(component),
      this.options.authorised,
      this.options.run,
    );
  }

  async observe(component: Component, phase: 'stop' | 'unregister'): Promise<void> {
    if (
      phase === 'unregister' &&
      !this.journal.actions.some(({ action }) => action === `unregister-${component}`)
    )
      return this.unregisterSteps(component, false);
    const verify =
      phase === 'stop' ? verifyRemovalServiceStopped : verifyRemovalServiceUnregistered;
    return this.writer.observe(`${phase}-${component}`, () =>
      verify(this.guard, this.review(component), this.options.authorised, this.options.run),
    );
  }
}
