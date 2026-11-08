/** Serialise disruptive navigation per host; identical pending requests join once. */
export class WindowNavigations {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly requests = new Map<string, Promise<void>>();

  busy(host: string): boolean {
    return this.tails.has(host);
  }

  wait(host: string): Promise<void> {
    return this.tails.get(host) ?? Promise.resolve();
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.tails.values());
  }

  run(host: string, key: string, action: () => Promise<void>): Promise<void> {
    const request = JSON.stringify([host, key]);
    const pending = this.requests.get(request);
    if (pending) return pending;
    const previous = this.wait(host);
    const operation = previous.catch(() => undefined).then(action);
    const settled = operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.tails.get(host) === settled) this.tails.delete(host);
        if (this.requests.get(request) === operation) this.requests.delete(request);
      });
    this.tails.set(host, settled);
    this.requests.set(request, operation);
    return operation;
  }
}
