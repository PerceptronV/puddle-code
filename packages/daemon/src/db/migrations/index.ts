import { migration001 } from './001-initial.js';
import { migration002 } from './002-project-hex-ids.js';
import { migration003 } from './003-profile-keyed-ui-state.js';
import { migration004 } from './004-profile-hex-ids.js';
import { migration005 } from './005-account-rate-limit-tracking.js';
import { migration006 } from './006-session-separate-branch.js';
import { migration007 } from './007-drop-rate-limit-tracking.js';
import { migration008 } from './008-default-branch-prefix.js';
import { migration009 } from './009-terminal-sessions.js';
import { migration010 } from './010-agent-title.js';
import { migration011 } from './011-project-archived.js';
import { migration012 } from './012-osc-title.js';
import { migration013 } from './013-profile-scoped-ui-state.js';
import { migration014 } from './014-scratchpad.js';
import { migration015 } from './015-profile-icon.js';
import { migration016 } from './016-session-env.js';
import { migration017 } from './017-session-cwd.js';
import { migration018 } from './018-project-abbrev.js';
import { migration019 } from './019-layouts.js';
import { migration020 } from './020-unique-agent-session-refs.js';
import { migration021 } from './021-agent-conversations.js';

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
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
];
