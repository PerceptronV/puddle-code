import { join } from 'node:path';
import {
  CONNECTION_POLICY,
  browserCredentialSchema,
  invitationSchema,
  browserAuthorityStateSchema,
  type BrowserRecord,
  type ProxyRecord,
} from '@puddle/shared';
import { atomicPrivateJson, digest, readPrivateJson, secret } from '@puddle/shared/node';

export type { BrowserRecord } from '@puddle/shared';

/** Only verifiers reach disk; invitations live for one process and one exchange. */
export class BrowserAuthority {
  private readonly browsers = new Map<string, BrowserRecord>();
  private readonly proxies = new Map<string, ProxyRecord>();
  private readonly invitations = new Map<
    string,
    { until: number; browser?: string; prefix?: string; path?: string }
  >();
  private readonly resources = new Map<string, Set<() => void>>();
  private readonly file: string;
  private readonly timer: ReturnType<typeof setInterval>;
  private dirty = false;
  constructor(
    home: string,
    readonly origin: string,
    readonly target: string,
    private readonly now = Date.now,
  ) {
    this.file = join(home, 'browser-authority', `${digest(`${target}\0${origin}`)}.json`);
    try {
      const state = browserAuthorityStateSchema.parse(readPrivateJson(this.file));
      if (state.origin !== origin || state.target !== target)
        throw new Error('Browser authority scope mismatch');
      for (const browser of state.browsers) this.browsers.set(browser.id, browser);
      for (const proxy of state.proxies) this.proxies.set(proxy.hash, proxy);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.timer = setInterval(() => {
      this.sweep();
      this.persist();
    }, 1000);
    this.timer.unref();
  }
  invite(): string {
    this.sweep();
    if (this.invitations.size >= 256) throw new Error('Too many pending invitations');
    const invitation = secret('iv_');
    this.invitations.set(digest(invitation), {
      until: this.now() + CONNECTION_POLICY.invitationMs,
    });
    return invitation;
  }
  exchange(invitation: string): string | null {
    const grant = this.consume(invitation);
    if (!grant || grant.browser) return null;
    const credential = secret('br_');
    const record = { id: secret(), hash: digest(credential), lastUsed: this.now() };
    this.browsers.set(record.id, record);
    this.dirty = true;
    this.persist();
    return credential;
  }
  authenticate(credential: string): BrowserRecord | null {
    if (!browserCredentialSchema.safeParse(credential).success) return null;
    const hash = digest(credential);
    const browser = [...this.browsers.values()].find((b) => b.hash === hash);
    if (!browser || !this.valid(browser)) return null;
    this.touch(browser);
    return browser;
  }
  valid(browser: BrowserRecord): boolean {
    if (this.browsers.get(browser.id) !== browser) return false;
    if (this.now() - browser.lastUsed < CONNECTION_POLICY.browserIdleMs) return true;
    this.revoke(browser);
    return false;
  }
  touch(browser: BrowserRecord): void {
    if (!this.valid(browser)) return;
    browser.lastUsed = this.now();
    this.dirty = true;
  }
  bind(browser: BrowserRecord, close: () => void): () => void {
    let set = this.resources.get(browser.id);
    if (!set) this.resources.set(browser.id, (set = new Set()));
    set.add(close);
    if (!this.valid(browser)) close();
    return () => {
      set.delete(close);
      if (set.size === 0) this.resources.delete(browser.id);
    };
  }
  revoke(browser: BrowserRecord): void {
    this.browsers.delete(browser.id);
    for (const [hash, proxy] of this.proxies)
      if (proxy.browser === browser.id) this.proxies.delete(hash);
    const callbacks = this.resources.get(browser.id);
    this.resources.delete(browser.id);
    for (const close of callbacks ?? []) close();
    this.dirty = true;
    this.persist();
  }
  proxyInvite(browser: BrowserRecord, prefix: string, path: string): string {
    if (!this.valid(browser)) throw new Error('Browser authorisation expired');
    const invitation = this.invite();
    this.invitations.set(digest(invitation), {
      until: this.now() + CONNECTION_POLICY.invitationMs,
      browser: browser.id,
      prefix,
      path,
    });
    return invitation;
  }
  exchangeProxy(invitation: string, prefix: string): { cookie: string; path: string } | null {
    const grant = this.consume(invitation);
    const browser = grant?.browser && this.browsers.get(grant.browser);
    if (!browser || !this.valid(browser) || grant.prefix !== prefix) return null;
    const credential = secret('pg_');
    const hash = digest(credential);
    this.proxies.set(hash, { hash, browser: browser.id, prefix });
    this.dirty = true;
    this.persist();
    return {
      cookie: `${this.cookieName(prefix)}=${credential}; HttpOnly; SameSite=Strict; Path=${prefix}; Max-Age=${CONNECTION_POLICY.browserIdleMs / 1000}`,
      path: grant.path ?? prefix,
    };
  }
  proxyBrowser(cookie: string | undefined, prefix: string): BrowserRecord | null {
    const name = this.cookieName(prefix);
    const value = cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(name + '='))
      ?.slice(name.length + 1);
    if (!value || !/^pg_[a-f0-9]{64}$/.test(value)) return null;
    const grant = this.proxies.get(digest(value));
    const browser = grant && grant.prefix === prefix && this.browsers.get(grant.browser);
    if (!browser || !this.valid(browser)) return null;
    this.touch(browser);
    return browser;
  }
  persist(): void {
    if (!this.dirty) return;
    atomicPrivateJson(this.file, {
      version: 1,
      origin: this.origin,
      target: this.target,
      browsers: [...this.browsers.values()],
      proxies: [...this.proxies.values()],
    });
    this.dirty = false;
  }
  close(): void {
    clearInterval(this.timer);
    this.persist();
    for (const callbacks of this.resources.values()) for (const close of callbacks) close();
    this.resources.clear();
  }
  private cookieName(prefix: string): string {
    return `puddle_proxy_${digest(this.origin + prefix).slice(0, 16)}`;
  }
  private consume(invitation: string) {
    if (!invitationSchema.safeParse(invitation).success) return null;
    const hash = digest(invitation);
    const grant = this.invitations.get(hash);
    this.invitations.delete(hash);
    return grant && grant.until > this.now() ? grant : null;
  }
  private sweep(): void {
    for (const browser of this.browsers.values()) this.valid(browser);
    for (const [hash, grant] of this.invitations)
      if (grant.until <= this.now()) this.invitations.delete(hash);
  }
}
