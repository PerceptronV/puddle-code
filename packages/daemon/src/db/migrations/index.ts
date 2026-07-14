import { migration001 } from './001-initial.js';
import { migration002 } from './002-project-hex-ids.js';
import { migration003 } from './003-profile-keyed-ui-state.js';
import { migration004 } from './004-profile-hex-ids.js';
import { migration005 } from './005-account-rate-limit-tracking.js';
import { migration006 } from './006-session-separate-branch.js';
import { migration007 } from './007-drop-rate-limit-tracking.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered, append-only. Schema changes always add a new entry (CLAUDE.md rule). */
export const MIGRATIONS: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
];
