import { projectSchema, type Project } from '@puddle/shared';

const KEY = 'puddle.project-lists.v1';
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_ENTRIES = 16;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
interface Entry {
  scope: string;
  profile: string | null;
  at: number;
  projects: Project[];
}

/** A bounded presentation cache; every restored list is revalidated against its host. */
export class ProjectListCache {
  constructor(
    private readonly storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = () =>
      localStorage,
    private readonly now: () => number = Date.now,
  ) {}

  private entries(): Entry[] {
    try {
      const raw = this.storage().getItem(KEY);
      if (!raw || raw.length * 2 > MAX_BYTES) return [];
      const values: unknown = JSON.parse(raw);
      if (!Array.isArray(values) || values.length > MAX_ENTRIES) return [];
      const entries: Entry[] = [];
      for (const value of values) {
        if (!value || typeof value !== 'object') continue;
        const { scope, profile, at, projects } = value as Entry;
        if (
          typeof scope !== 'string' ||
          scope.length > 2048 ||
          (profile !== null && typeof profile !== 'string') ||
          !Number.isFinite(at) ||
          at > this.now() ||
          this.now() - at > MAX_AGE
        )
          continue;
        const parsed = projectSchema.array().max(2000).safeParse(projects);
        if (
          parsed.success &&
          parsed.data.every((p) => profile === null || p.profile_id === profile)
        )
          entries.push({ scope, profile, at, projects: parsed.data });
      }
      return entries;
    } catch {
      return [];
    }
  }

  read(scope: string, profile?: string): Project[] | undefined {
    const entries = this.entries();
    const exact = entries.find(
      (entry) => entry.scope === scope && entry.profile === (profile ?? null),
    );
    if (exact) return exact.projects;
    const all = entries.find((entry) => entry.scope === scope && entry.profile === null);
    return all?.projects.filter(
      (project) => profile === undefined || project.profile_id === profile,
    );
  }

  write(scope: string, projects: Project[], profile?: string): void {
    try {
      const parsed = projectSchema.array().max(2000).safeParse(projects);
      if (
        !parsed.success ||
        parsed.data.some((p) => profile !== undefined && p.profile_id !== profile)
      )
        return;
      const entry: Entry = {
        scope,
        profile: profile ?? null,
        at: this.now(),
        projects: parsed.data,
      };
      if (scope.length > 2048 || JSON.stringify(entry).length * 2 > MAX_ENTRY_BYTES) return;
      // A full refresh supersedes profile snapshots. A profile refresh removes
      // the older full snapshot so an archived/deleted row cannot win on reload.
      const entries = this.entries().filter(
        (item) =>
          item.scope !== scope ||
          (profile !== undefined && item.profile !== null && item.profile !== profile),
      );
      entries.push(entry);
      while (entries.length > MAX_ENTRIES || JSON.stringify(entries).length * 2 > MAX_BYTES)
        entries.shift();
      this.storage().setItem(KEY, JSON.stringify(entries));
    } catch {
      /* Storage denial/quota never makes a successful host read fail. */
    }
  }

  forget(scope: string): void {
    try {
      this.storage().setItem(
        KEY,
        JSON.stringify(this.entries().filter((item) => item.scope !== scope)),
      );
    } catch {
      /* Optional cache. */
    }
  }
}

export function remoteProjectScope(host: {
  service: string;
  account: string;
  host: string;
  peer: string;
}): string {
  return JSON.stringify(['remote', host.service, host.account, host.host, host.peer]);
}

export const projectListCache = new ProjectListCache();
