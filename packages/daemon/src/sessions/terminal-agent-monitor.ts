import type { AgentAdapter } from '../agents/adapter.js';
import { foregroundProcesses, readProcessSnapshot } from '../pty/foreground-process.js';

export interface TerminalAgentTarget {
  session: string;
  runtime: string;
  pid: number;
}

interface Options {
  targets(): TerminalAgentTarget[];
  adapters: Pick<AgentAdapter, 'id' | 'matchesProcess'>[];
  changed(session: string): void;
  snapshot?: typeof readProcessSnapshot;
  intervalMs?: number;
}

/** Transient icon hints only: never adopts conversations or changes session kind/status. */
export class TerminalAgentMonitor {
  private readonly detected = new Map<string, { runtime: string; agent: string }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private pending = false;
  private disposed = false;

  constructor(private readonly options: Options) {
    this.timer = setInterval(() => void this.refresh(), options.intervalMs ?? 3000);
    this.timer.unref?.();
  }

  get(session: string, runtime: string): string | null {
    const value = this.detected.get(session);
    return value?.runtime === runtime ? value.agent : null;
  }

  forget(session: string): void {
    if (this.detected.delete(session)) this.options.changed(session);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.detected.clear();
  }

  async refresh(): Promise<void> {
    if (this.pending || this.disposed) return;
    const targets = this.options.targets();
    if (!targets.length) return;
    this.pending = true;
    try {
      // Inspection failure removes hints; an unavailable ps must never leave
      // a stale agent mark or interfere with the shell itself.
      const entries = await (this.options.snapshot ?? readProcessSnapshot)().catch(() => new Map());
      if (this.disposed) return;
      const current = new Map(this.options.targets().map((target) => [target.session, target]));
      for (const target of targets) {
        const now = current.get(target.session);
        if (now?.runtime !== target.runtime || now.pid !== target.pid) continue;
        const matches = new Set<string>();
        for (const path of foregroundProcesses(target.pid, entries)) {
          for (const entry of path) {
            let recognised = false;
            for (const adapter of this.options.adapters) {
              if (!adapter.matchesProcess?.(entry.command)) continue;
              matches.add(adapter.id);
              recognised = true;
            }
            if (recognised) break;
          }
        }
        // The outermost recognised agent owns its tools/subagents. Ambiguous
        // pipelines retain the ordinary terminal glyph, even through wrappers.
        const agent = matches.size === 1 ? [...matches][0]! : null;
        const previous = this.get(target.session, target.runtime);
        if (agent) this.detected.set(target.session, { runtime: target.runtime, agent });
        else this.detected.delete(target.session);
        if (agent !== previous) this.options.changed(target.session);
      }
    } finally {
      this.pending = false;
    }
  }
}
