import type { AccountStore } from '../../db/stores/accounts.js';
import { KeyedMutex } from '../../git/mutex.js';
import type { HostBackgroundTasks } from '../../host/lifecycle/background.js';
import type { PtyExitEvent, PtyManager } from '../../pty/pty-manager.js';
import { isBinaryAvailable } from '../binary.js';
import type { AdapterRegistry } from '../registry.js';

/** Adapter-owned auth checks, tracked through daemon shutdown without reading credentials. */
export class AccountObservations {
  private closed = false;
  private readonly mutex = new KeyedMutex();
  private readonly logins = new Map<number, { dirty: boolean }>();

  constructor(
    private readonly deps: {
      accounts: AccountStore;
      adapters: AdapterRegistry;
      ptys: PtyManager;
      background: HostBackgroundTasks;
    },
  ) {
    deps.ptys.on('exit', this.exited);
  }

  /** Stored auth flags can be stale after imports or an external login/logout. */
  refresh(): void {
    if (this.closed) return;
    this.deps.background.startBatch('account-checks', this.deps.accounts.list(), (account) =>
      this.check(account.id, true),
    );
  }

  private exited = (event: PtyExitEvent): void => {
    if (this.closed || event.exitCode !== 0) return;
    const match = /^login-([0-9]+)$/.exec(event.stream);
    if (!match) return;
    const id = Number(match[1]);
    const active = this.logins.get(id);
    if (active) {
      active.dirty = true;
      return;
    }
    const state = { dirty: true };
    if (
      this.deps.background.start(`login-check:${id}`, async () => {
        try {
          do {
            state.dirty = false;
            await this.check(id, false);
          } while (state.dirty);
        } finally {
          this.logins.delete(id);
        }
      })
    )
      this.logins.set(id, state);
  };

  private check(id: number, startup: boolean): Promise<void> {
    // A slow startup probe cannot overwrite a newer login result out of order.
    return this.mutex.run(`account-auth:${id}`, async () => {
      let loggedIn: boolean;
      try {
        const account = this.deps.accounts.get(id);
        const adapter = this.deps.adapters.get(account.agent_type);
        if (startup) {
          adapter.reconcileConfigDir?.(account);
          // Missing binaries must not turn stored credentials into a logout.
          if (!adapter.checkLoggedIn || !isBinaryAvailable(adapter)) return;
        }
        // Some login flows exit zero even when cancelled; use the native check
        // where available. Agents without that hook retain their exit evidence.
        loggedIn = adapter.checkLoggedIn ? await adapter.checkLoggedIn(account) : true;
      } catch {
        // Deleted accounts, unsupported adapters or failed probes leave the flag alone.
        return;
      }
      this.deps.accounts.setLoggedIn(id, loggedIn);
    });
  }

  close(): void {
    this.closed = true;
    this.deps.ptys.off('exit', this.exited);
    // Already-admitted checks belong to the host background drain.
  }
}
