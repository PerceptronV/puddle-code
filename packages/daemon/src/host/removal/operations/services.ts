import { realpathSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HOST_REMOVAL_SERVICES_BYTES,
  hostRemovalServicesSchema,
  type HostRemovalServices as ServiceJournal,
  type HostRemovalServiceAction,
  type HostRemovalServiceReview,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  digest,
  privateDirectory,
  privatePath,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import { HostActionWriter } from '../../installation/action-writer.js';
import { readOwnedServiceDefinition } from '../../supervision/definition.js';
import { HostRemovalGuard } from '../guard.js';
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
}

const file = (home: string) => join(home, 'installation/removal/services.json');

function validate(value: unknown): ServiceJournal {
  const journal = hostRemovalServicesSchema.parse(value);
  for (const { review, source } of journal.services)
    if (
      Buffer.from(source, 'base64').toString('base64') !== source ||
      digest(source) !== review.sourceDigest
    )
      throw new Error('Removal service source does not match its review');
  return journal;
}

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
        ...present.map((component) => ({ action: `stop-${component}`, state: 'planned' })),
        ...present.map((component) => ({ action: `unregister-${component}`, state: 'planned' })),
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

  unregister(component: Component): Promise<void> {
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

  observe(component: Component, phase: 'stop' | 'unregister'): Promise<void> {
    const verify =
      phase === 'stop' ? verifyRemovalServiceStopped : verifyRemovalServiceUnregistered;
    return this.writer.observe(`${phase}-${component}`, () =>
      verify(this.guard, this.review(component), this.options.authorised, this.options.run),
    );
  }
}
