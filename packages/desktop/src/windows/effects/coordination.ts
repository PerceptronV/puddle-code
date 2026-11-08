import type { DesktopNotificationClaim, DesktopWindowEffectsStatus } from '@puddle/shared';

export interface EffectWindow {
  id: string;
  host: string;
  kind: 'host' | 'project' | 'pane';
  focused: boolean;
}

/** One automatic poller per host, and one sound/delivery decision per attention event. */
export class WindowEffects {
  private readonly claims = new Map<string, number>();
  private readonly published = new Map<string, string>();
  constructor(
    private readonly windows: () => EffectWindow[],
    private readonly send: (id: string, status: DesktopWindowEffectsStatus) => void,
    private readonly now = Date.now,
  ) {}

  private candidates(id: string) {
    const windows = this.windows();
    const sender = windows.find((window) => window.id === id);
    return sender ? windows.filter((window) => window.host === sender.host) : [];
  }

  private owner(windows: EffectWindow[]) {
    return windows.find((window) => window.kind === 'host') ?? windows[0];
  }

  status(id: string): DesktopWindowEffectsStatus {
    return {
      hostOffers: this.owner(this.candidates(id))?.id === id,
      desktopOffers: this.owner(this.windows())?.id === id,
    };
  }

  publish(): void {
    const live = this.windows();
    for (const id of this.published.keys())
      if (!live.some((window) => window.id === id)) this.published.delete(id);
    for (const window of live) {
      const status = this.status(window.id);
      const signature = JSON.stringify(status);
      if (this.published.get(window.id) === signature) continue;
      this.published.set(window.id, signature);
      this.send(window.id, status);
    }
  }

  claimNotification(id: string, request: DesktopNotificationClaim): boolean {
    const windows = this.candidates(id);
    // The focused renderer knows whether a human recently interacted with this session.
    const elected = windows.find((window) => window.focused) ?? this.owner(windows);
    if (!elected || elected.id !== id) return false;
    const key = JSON.stringify([elected.host, request.id, !!request.legacy]);
    const now = this.now();
    if ((this.claims.get(key) ?? -Infinity) > now) return false;
    this.claims.delete(key);
    this.claims.set(key, request.legacy ? now + 2000 : Infinity);
    while (this.claims.size > 2048) this.claims.delete(this.claims.keys().next().value!);
    return true;
  }
}
