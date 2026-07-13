import { migration001 } from './001-initial.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered, append-only. Schema changes always add a new entry (CLAUDE.md rule). */
export const MIGRATIONS: Migration[] = [migration001];
