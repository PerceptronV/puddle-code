import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../../../src/db/migrations/index.js';
import { ensureHome, resolvePaths } from '../../../src/paths.js';
import { sh } from '../git-fixtures.js';

/**
 * v0.3.14, c33cdeef3a5df58badf73c3dd74cee8dca23bdbe, shipped schema 28.
 * Its migrations 1–28 are byte-identical to these retained modules. Pin their
 * complete version/name/SQL manifest rather than duplicating hundreds of lines
 * or requiring Git/history at test runtime. Later migrations run only in the
 * actual new daemon process.
 */
export function legacyDatabase(home: string, autoResume: boolean) {
  const historical = MIGRATIONS.filter((migration) => migration.version <= 28);
  const digest = createHash('sha256').update(JSON.stringify(historical)).digest('hex');
  if (
    historical.length !== 28 ||
    digest !== 'c6e73547b2b12ab94668899a5012cef5b4250f1aa6021eacd7b28cfc92215ad7'
  )
    throw new Error('Historical v0.3.14 migration manifest changed');
  const paths = resolvePaths(home);
  ensureHome(paths);
  writeFileSync(paths.configFile, JSON.stringify({ configVersion: 3, autoResume }));
  writeFileSync(join(home, 'test-default-runtime-launcher'), '');
  const worktree = join(home, 'worktree');
  mkdirSync(worktree);
  sh(worktree, 'init', '-b', 'main');
  writeFileSync(join(worktree, 'README'), 'legacy worktree\n');
  sh(worktree, 'add', '.');
  sh(
    worktree,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'seed',
  );
  const account = paths.accountConfigDir('1111111111', 'runtime-test', 'legacy');
  mkdirSync(account, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(account, 'native-catalogue-fixture.json'),
    '{"legacy-native-ref":"retained"}\n',
  );
  const session = randomUUID();
  const missingRef = randomUUID();
  const now = '2026-10-01T12:00:00.000Z';
  const db = new Database(paths.dbFile);
  try {
    for (const migration of historical) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(migration.sql);
        if ((db.pragma('foreign_key_check') as unknown[]).length)
          throw new Error(`Historical migration ${migration.version} violates foreign keys`);
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO profiles (id,name,settings,created_at) VALUES (?,?,?,?)').run(
      '1111111111',
      'Legacy profile',
      '{"captureSessionEnv":true}',
      now,
    );
    db.prepare(
      "INSERT INTO repos (id,path,default_base_branch,fetch_enabled) VALUES (1,?,'main',0)",
    ).run(worktree);
    db.prepare(
      'INSERT INTO projects (id,profile_id,repo_id,name,created_at,updated_at) VALUES (?,?,1,?,?,?)',
    ).run('2222222222', '1111111111', 'Legacy project', now, now);
    db.prepare(
      'INSERT INTO accounts (id,profile_id,agent_type,label,config_dir,logged_in,created_at) VALUES (1,?,?,?,?,1,?)',
    ).run('1111111111', 'runtime-test', 'legacy', account, now);
    db.prepare(
      'INSERT INTO agent_conversations (id,profile_id,agent_type,agent_session_ref,native_cwd,native_title,preferred_account_id,last_seen_at) VALUES (1,?,?,?,?,?,1,?)',
    ).run('1111111111', 'runtime-test', 'legacy-native-ref', worktree, 'Native title', now);
    const insert = db.prepare(`INSERT INTO sessions (
      id,project_id,account_id,conversation_id,worktree_path,canonical_worktree_path,
      base_branch,branch,separate_branch,branch_owned,kind,agent_type,title,status,
      session_env,created_at,updated_at
    ) VALUES (?, '2222222222', 1, ?, ?, ?, 'main', 'main', 0, 0, 'agent',
      'runtime-test', 'User placement title', 'running', ?, ?, ?)`);
    for (const [id, conversation] of [
      [session, 1],
      [missingRef, null],
    ] as const)
      insert.run(
        id,
        conversation,
        worktree,
        realpathSync(worktree),
        '{"CAPTURED_FOR_TEST":"legacy-value"}',
        now,
        now,
      );
    db.prepare('INSERT INTO events (session_id,type,payload,created_at) VALUES (?,?,?,?)').run(
      session,
      'created',
      '{"source":"legacy-fixture"}',
      now,
    );
    db.prepare(
      "INSERT INTO layouts (profile_id,scope,project_id,name,active_session,created_at,updated_at) VALUES (?,'project',?,?,?,?,?)",
    ).run('1111111111', '2222222222', 'Legacy layout', session, now, now);
    mkdirSync(paths.sessionLogDir(session), { recursive: true });
    writeFileSync(join(paths.sessionLogDir(session), 'legacy.log'), 'earlier terminal output\n');
    return { paths, session, missingRef, account, worktree };
  } finally {
    db.close();
  }
}
