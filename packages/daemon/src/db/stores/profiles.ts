import { randomBytes } from 'node:crypto';
import { profileSettingsSchema, type Profile, type ProfileSettings } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: string;
  name: string;
  branch_prefix: string;
  icon: string | null;
  icon_colour: string | null;
  settings: string;
  created_at: string;
}

function toProfile(r: Row): Profile {
  return {
    id: r.id,
    name: r.name,
    branch_prefix: r.branch_prefix,
    icon: r.icon,
    icon_colour: r.icon_colour,
    created_at: r.created_at,
  };
}

export class ProfileStore {
  constructor(private readonly db: Db) {}

  create(input: { name: string; branch_prefix: string }): Profile {
    try {
      // 10 hex chars (5 random bytes), like project ids: opaque handles —
      // the name is a display label and never keys anything.
      const id = randomBytes(5).toString('hex');
      this.db
        .prepare(`INSERT INTO profiles (id, name, branch_prefix, created_at) VALUES (?, ?, ?, ?)`)
        .run(id, input.name, input.branch_prefix, new Date().toISOString());
      return this.get(id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict('profile_exists', `profile '${input.name}' already exists`);
      }
      throw e;
    }
  }

  list(): Profile[] {
    return (this.db.prepare(`SELECT * FROM profiles ORDER BY created_at`).all() as Row[]).map(
      toProfile,
    );
  }

  get(id: string): Profile {
    const row = this.db.prepare(`SELECT * FROM profiles WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('profile', id);
    return toProfile(row);
  }

  setBranchPrefix(id: string, branchPrefix: string): Profile {
    this.get(id); // 404 before a silent no-op UPDATE
    this.db.prepare(`UPDATE profiles SET branch_prefix = ? WHERE id = ?`).run(branchPrefix, id);
    return this.get(id);
  }

  /** Rename the profile's display label. Names are unique — a clash 409s, like create. */
  setName(id: string, name: string): Profile {
    this.get(id); // 404 before a silent no-op UPDATE
    try {
      this.db.prepare(`UPDATE profiles SET name = ? WHERE id = ?`).run(name, id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict('profile_exists', `profile '${name}' already exists`);
      }
      throw e;
    }
    return this.get(id);
  }

  /** Set/clear the profile's icon glyph and/or its colour (SPEC §11). */
  setAppearance(id: string, patch: { icon?: string | null; icon_colour?: string | null }): Profile {
    this.get(id); // 404 before a silent no-op UPDATE
    const sets: string[] = [];
    const values: Array<string | null> = [];
    if (patch.icon !== undefined) {
      sets.push('icon = ?');
      values.push(patch.icon);
    }
    if (patch.icon_colour !== undefined) {
      sets.push('icon_colour = ?');
      values.push(patch.icon_colour);
    }
    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    return this.get(id);
  }

  getSettings(id: string): ProfileSettings {
    const row = this.db.prepare(`SELECT settings FROM profiles WHERE id = ?`).get(id) as
      Pick<Row, 'settings'> | undefined;
    if (!row) throw ApiError.notFound('profile', id);
    return profileSettingsSchema.parse(JSON.parse(row.settings));
  }

  patchSettings(id: string, patch: Record<string, unknown>): ProfileSettings {
    const merged = profileSettingsSchema.parse({ ...this.getSettings(id), ...patch });
    this.db
      .prepare(`UPDATE profiles SET settings = ? WHERE id = ?`)
      .run(JSON.stringify(merged), id);
    return merged;
  }
}
