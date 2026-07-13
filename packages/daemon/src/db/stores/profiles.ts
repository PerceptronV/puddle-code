import { profileSettingsSchema, type Profile, type ProfileSettings } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  name: string;
  branch_prefix: string;
  settings: string;
  created_at: string;
}

function toProfile(r: Row): Profile {
  return { id: r.id, name: r.name, branch_prefix: r.branch_prefix, created_at: r.created_at };
}

export class ProfileStore {
  constructor(private readonly db: Db) {}

  create(input: { name: string; branch_prefix: string }): Profile {
    try {
      const info = this.db
        .prepare(`INSERT INTO profiles (name, branch_prefix, created_at) VALUES (?, ?, ?)`)
        .run(input.name, input.branch_prefix, new Date().toISOString());
      return this.get(Number(info.lastInsertRowid));
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict('profile_exists', `profile '${input.name}' already exists`);
      }
      throw e;
    }
  }

  list(): Profile[] {
    return (this.db.prepare(`SELECT * FROM profiles ORDER BY id`).all() as Row[]).map(toProfile);
  }

  get(id: number): Profile {
    const row = this.db.prepare(`SELECT * FROM profiles WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('profile', id);
    return toProfile(row);
  }

  getSettings(id: number): ProfileSettings {
    const row = this.db.prepare(`SELECT settings FROM profiles WHERE id = ?`).get(id) as
      Pick<Row, 'settings'> | undefined;
    if (!row) throw ApiError.notFound('profile', id);
    return profileSettingsSchema.parse(JSON.parse(row.settings));
  }

  patchSettings(id: number, patch: Record<string, unknown>): ProfileSettings {
    const merged = profileSettingsSchema.parse({ ...this.getSettings(id), ...patch });
    this.db
      .prepare(`UPDATE profiles SET settings = ? WHERE id = ?`)
      .run(JSON.stringify(merged), id);
    return merged;
  }
}
