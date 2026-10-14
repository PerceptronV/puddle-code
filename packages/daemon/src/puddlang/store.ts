import { createHash } from 'node:crypto';
import {
  puddlangRunSchema,
  puddlangEventSchema,
  type PuddlangStart,
  type PuddlangRun,
} from '@puddle/shared';
import type { Db } from '../db/db.js';
import { ApiError } from '../http/errors.js';

export class PuddlangStore {
  constructor(private readonly db: Db) {}
  has(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM puddlang_runs WHERE id = ?').get(id));
  }
  reconcile(): void {
    this.db
      .prepare(
        "UPDATE puddlang_runs SET status = 'interrupted', error = 'Daemon restarted; instructions were not replayed', updated_at = ? WHERE status = 'running'",
      )
      .run(new Date().toISOString());
  }
  create(profile: string, input: PuddlangStart): { run: PuddlangRun; fresh: boolean } {
    const submission = JSON.stringify(input);
    const hash = createHash('sha256').update(submission).digest('hex');
    const previous = this.db
      .prepare('SELECT profile_id, source_hash FROM puddlang_runs WHERE id = ?')
      .get(input.id) as { profile_id: string; source_hash: string } | undefined;
    if (previous) {
      if (previous.profile_id !== profile || previous.source_hash !== hash)
        throw ApiError.conflict(
          'submission_conflict',
          'This submission id already identifies different work',
        );
      return { run: this.get(profile, input.id), fresh: false };
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO puddlang_runs (id, profile_id, source_hash, submission, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.id, profile, hash, submission, 'running', now, now);
    return { run: this.get(profile, input.id), fresh: true };
  }
  get(profile: string, id: string): PuddlangRun {
    const row = this.db
      .prepare('SELECT * FROM puddlang_runs WHERE id = ? AND profile_id = ?')
      .get(id, profile) as Record<string, unknown> | undefined;
    if (!row) throw ApiError.notFound('puddlang run', id);
    return puddlangRunSchema.parse({
      ...row,
      result: typeof row['result'] === 'string' ? JSON.parse(row['result']) : null,
    });
  }
  finish(
    id: string,
    status: PuddlangRun['status'],
    result: unknown = null,
    error: string | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE puddlang_runs SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(status, JSON.stringify(result ?? null), error, new Date().toISOString(), id);
  }
  event(id: string, type: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO puddlang_events (run_id, type, data, created_at) VALUES (?, ?, ?, ?)')
      .run(id, type, JSON.stringify(data ?? null), new Date().toISOString());
  }
  events(profile: string, id: string, after: number) {
    this.get(profile, id);
    const rows = this.db
      .prepare(
        'SELECT * FROM puddlang_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 100',
      )
      .all(id, after) as Array<Record<string, unknown>>;
    return {
      events: rows.map((row) =>
        puddlangEventSchema.parse({ ...row, data: JSON.parse(String(row['data'])) }),
      ),
    };
  }
}
