/**
 * One cockpit per host, independent of the number or kind of native windows.
 * No Electron dependency: connection lifetime and races are exercised in isolation.
 */
export interface WindowCockpit {
  origin: string;
  stop(): Promise<void>;
}

export interface HostConnection<C extends WindowCockpit, W> {
  target: string;
  cockpit: C;
  windows: Map<string, W>;
  refreshing: Promise<void> | null;
}

export class HostConnections<C extends WindowCockpit, W> {
  readonly hosts = new Map<string, HostConnection<C, W>>();
  private readonly connecting = new Map<string, Promise<HostConnection<C, W> | undefined>>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly stops = new WeakMap<C, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly connect: (target: string, previous?: C, refreshId?: string) => Promise<C>,
  ) {}

  private stop(cockpit: C): Promise<void> {
    let operation = this.stops.get(cockpit);
    if (!operation) {
      operation = Promise.resolve().then(() => cockpit.stop());
      this.stops.set(cockpit, operation);
    }
    return operation;
  }

  has(target: string): boolean {
    return this.hosts.has(target) || this.connecting.has(target);
  }

  private acquire(target: string): Promise<HostConnection<C, W> | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const existing = this.hosts.get(target);
    if (existing) return Promise.resolve(existing);
    const pending = this.connecting.get(target);
    if (pending) return pending;
    const start = async () => {
      await this.retiring.get(target);
      if (this.disposed) return undefined;
      const cockpit = await this.connect(target);
      if (this.disposed) {
        await this.stop(cockpit);
        return undefined;
      }
      const host: HostConnection<C, W> = {
        target,
        cockpit,
        windows: new Map(),
        refreshing: null,
      };
      this.hosts.set(target, host);
      return host;
    };
    const operation = start().finally(() => {
      if (this.connecting.get(target) === operation) this.connecting.delete(target);
    });
    this.connecting.set(target, operation);
    return operation;
  }

  async open(
    target: string,
    id: string,
    create: (host: HostConnection<C, W>) => W,
  ): Promise<W | undefined> {
    const host = await this.acquire(target);
    if (!host || this.disposed) return undefined;
    if (this.hosts.get(target) !== host) return this.open(target, id, create);
    const existing = host.windows.get(id);
    if (existing) return existing;
    try {
      const window = create(host);
      host.windows.set(id, window);
      return window;
    } catch (error) {
      if (host.windows.size === 0) await this.retire(host);
      throw error;
    }
  }

  close(target: string, id: string): Promise<void> {
    const host = this.hosts.get(target);
    if (!host) return Promise.resolve();
    host.windows.delete(id);
    return host.windows.size === 0 ? this.retire(host) : Promise.resolve();
  }

  refresh(
    host: HostConnection<C, W>,
    refreshId?: string,
    replaced?: (previous: C) => void,
  ): Promise<void> {
    if (this.disposed || this.hosts.get(host.target) !== host) return Promise.resolve();
    if (host.refreshing) return host.refreshing;
    const previous = host.cockpit;
    const operation = (async () => {
      await this.stop(previous);
      // Closing the last window while stopping must not reconnect the host.
      if (this.disposed || this.hosts.get(host.target) !== host) return;
      const next = await this.connect(host.target, previous, refreshId);
      host.cockpit = next;
      // Retirement waits for this operation, then stops the replacement too.
      if (this.disposed || this.hosts.get(host.target) !== host) return;
      replaced?.(previous);
    })().finally(() => {
      if (host.refreshing === operation) host.refreshing = null;
    });
    host.refreshing = operation;
    return operation;
  }

  private retire(host: HostConnection<C, W>): Promise<void> {
    if (this.hosts.get(host.target) !== host)
      return this.retiring.get(host.target) ?? Promise.resolve();
    this.hosts.delete(host.target);
    const operation = (async () => {
      // A replacement that completes after close still belongs to this retirement.
      await host.refreshing?.catch(() => undefined);
      await this.stop(host.cockpit);
    })().finally(() => {
      if (this.retiring.get(host.target) === operation) this.retiring.delete(host.target);
    });
    this.retiring.set(host.target, operation);
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([
      ...[...this.hosts.values()].map((host) => this.retire(host)),
      ...this.connecting.values(),
      ...this.retiring.values(),
    ]);
  }
}
