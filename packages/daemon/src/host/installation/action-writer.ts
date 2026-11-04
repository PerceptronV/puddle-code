import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';

type Actions<Action extends string> = {
  actions: Array<{ action: Action; state: 'planned' | 'started' | 'finished' }>;
};

/** Durable serial intent shared by update and removal; callers retain host exclusion. */
export class HostActionWriter<Action extends string, Journal extends Actions<Action>> {
  constructor(
    private readonly options: {
      path: string;
      initial: Journal;
      parse: (value: unknown) => Journal;
      maxBytes: number;
      requireCurrent: (action: Action) => void;
      write?: typeof atomicPrivateJson;
      /** Existing journals can be observed, but a started action is never dispatched again. */
      resume?: boolean;
    },
  ) {
    if (options.resume) {
      this.read();
      return;
    }
    try {
      readPrivateJson(options.path, options.maxBytes);
      throw new Error('Host actions were already recorded');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.save(options.initial);
  }

  read(): Journal {
    const record = this.options.parse(readPrivateJson(this.options.path, this.options.maxBytes));
    const identity = (value: Journal) => ({
      ...value,
      actions: value.actions.map(({ action }) => action),
    });
    if (JSON.stringify(identity(record)) !== JSON.stringify(identity(this.options.initial)))
      throw new Error('Host actions do not match the accepted operation');
    return record;
  }

  async run(action: Action, execute: () => Promise<void>): Promise<void> {
    this.options.requireCurrent(action);
    const journal = this.read();
    const next = journal.actions.find((item) => item.state !== 'finished');
    if (next?.action !== action || next.state !== 'planned')
      throw new Error('Host action was already attempted or is out of order');
    next.state = 'started';
    this.save(journal);
    await execute();
    this.finish(journal, action);
  }

  /** Recovery supplies fresh proof; inspection cannot execute an unstarted action. */
  async observe(action: Action, verify: () => Promise<void>): Promise<void> {
    this.options.requireCurrent(action);
    const journal = this.read();
    const entry = journal.actions.find((item) => item.action === action);
    if (!entry || entry.state === 'planned')
      throw new Error('Host action has no recorded attempt to observe');
    await verify();
    this.finish(journal, action);
  }

  private finish(journal: Journal, action: Action): void {
    this.options.requireCurrent(action);
    if (JSON.stringify(this.read()) !== JSON.stringify(journal))
      throw new Error('Host actions changed during execution');
    journal.actions.find((item) => item.action === action)!.state = 'finished';
    this.save(journal);
  }

  private save(input: Journal): void {
    const record = this.options.parse(input);
    if (Buffer.byteLength(JSON.stringify(record) + '\n') > this.options.maxBytes)
      throw new Error('Host action journal exceeds its limit');
    (this.options.write ?? atomicPrivateJson)(this.options.path, record, { syncDirectory: true });
  }
}
