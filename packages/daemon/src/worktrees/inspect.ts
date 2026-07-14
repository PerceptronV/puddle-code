import type { CommitSummary, DiffEntry, DiffStatus, ShowCommitResponse } from '@puddle/shared';
import { git, gitBuffer } from '../git/exec.js';
import { ApiError } from '../http/errors.js';

/** Read-only git inspection for a session's worktree (SPEC §6/§8, Phase 3
 * history view): diff vs. base or a commit, a blob at a ref, log, show.
 * Deliberately separate from `manager.ts` — nothing here mutates the repo,
 * so none of it runs under the per-repo mutex (precedent: `GET
 * /api/repos/:id/branches` in `../http/routes/repos.ts`).
 */

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
/** Binary sniffing looks for a NUL byte within this many leading bytes (matches worktree-files.ts). */
const SNIFF_BYTES = 8 * 1024;

const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/^~@-]*$/;
const SHA_RE = /^[0-9a-f]{4,40}$/;

/** Argv-injection guard: a leading `-` (e.g. `--upload-pack=x`) can never match. */
export function assertSafeRef(ref: string): void {
  if (!SAFE_REF_RE.test(ref)) {
    throw ApiError.badRequest('invalid_ref', `'${ref}' is not a safe git ref`);
  }
}

export function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) {
    throw ApiError.badRequest('invalid_ref', `'${sha}' is not a valid commit sha`);
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** `origin/<base>` when the worktree has that remote-tracking ref, else the local branch. */
async function resolveBaseRef(worktree: string, baseBranch: string): Promise<string> {
  const hasRemote = await refExists(worktree, `refs/remotes/origin/${baseBranch}`);
  return hasRemote ? `origin/${baseBranch}` : baseBranch;
}

/**
 * The merge-base, not the branch tip: the diff must show what the session
 * changed, not upstream drift the base branch picked up meanwhile.
 */
export async function resolveBaseSha(
  worktree: string,
  baseBranch: string,
): Promise<{ sha: string; ref: string }> {
  const ref = await resolveBaseRef(worktree, baseBranch);
  const sha = await git(['merge-base', ref, 'HEAD'], { cwd: worktree });
  return { sha, ref };
}

function mapStatusLetter(letter: string | undefined): DiffStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
      return 'modified';
    default:
      // T (type change), C (copy, only with -C, unused here), or anything else.
      return 'modified';
  }
}

/**
 * Shared NUL-token parser for `--name-status -z` output (both `git diff` and
 * `git diff-tree`): a rename record carries two paths (old, new) after its
 * `R<score>` status token; everything else is one status + one path.
 */
function parseStatusTokens(tokens: string[]): DiffEntry[] {
  const entries: DiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i++];
    if (!statusToken) continue;
    const letter = statusToken[0];
    if (letter === 'R') {
      const oldPath = tokens[i++] ?? '';
      const newPath = tokens[i++] ?? '';
      entries.push({ path: newPath, status: 'renamed', old_path: oldPath });
    } else {
      const path = tokens[i++] ?? '';
      entries.push({ path, status: mapStatusLetter(letter), old_path: null });
    }
  }
  return entries;
}

function splitNulTokens(raw: string): string[] {
  return raw.split('\0').filter((t) => t.length > 0);
}

/**
 * Working tree vs. `sha`: tracked changes via `diff --name-status`, plus
 * untracked files via `ls-files --others --exclude-standard` (which honours
 * the repo's `.puddle/` info/exclude entry automatically — WorktreeManager
 * writes it once per repo at worktree-creation time).
 */
export async function diffNameStatus(worktree: string, sha: string): Promise<DiffEntry[]> {
  const trackedRaw = await git(['diff', '--name-status', '-z', '-M', sha, '--'], { cwd: worktree });
  const tracked = parseStatusTokens(splitNulTokens(trackedRaw));

  const untrackedRaw = await git(['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: worktree,
  });
  const untracked: DiffEntry[] = splitNulTokens(untrackedRaw).map((path) => ({
    path,
    status: 'added',
    old_path: null,
  }));

  return [...tracked, ...untracked];
}

/**
 * A file's content at `ref`. Returns `null` when the blob does not exist
 * there (missing path or unknown ref) — the route turns that into 404
 * `not_at_ref`. Uses `gitBuffer`, not `git()`: trimming would corrupt a
 * trailing newline or binary bytes.
 */
export async function blobAt(
  worktree: string,
  ref: string,
  path: string,
): Promise<{ content: string | null; binary: boolean } | null> {
  let buf: Buffer;
  try {
    buf = await gitBuffer(['show', `${ref}:${path}`], { cwd: worktree });
  } catch {
    return null;
  }
  const binary = buf.subarray(0, SNIFF_BYTES).includes(0);
  return { content: binary ? null : buf.toString('utf8'), binary };
}

const LOG_FORMAT = `%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${RECORD_SEP}`;

function parseLogRecord(record: string): CommitSummary {
  // `--format=` behaves as `tformat:`, which appends its own terminator (a
  // newline) after our own %x1e — so every record but the first carries a
  // leading newline from the previous entry's terminator.
  const [sha, author_name, author_email, authored_at, subject] = record
    .replace(/^\n/, '')
    .split(FIELD_SEP);
  return {
    sha: sha ?? '',
    author_name: author_name ?? '',
    author_email: author_email ?? '',
    authored_at: authored_at ?? '',
    subject: subject ?? '',
  };
}

/** Paginated commit history: `limit+1` fetched so `has_more` is known without a second query. */
export async function logPage(
  worktree: string,
  limit: number,
  skip: number,
): Promise<{ commits: CommitSummary[]; has_more: boolean }> {
  const raw = await git(
    ['log', `--format=${LOG_FORMAT}`, '-n', String(limit + 1), `--skip=${skip}`],
    { cwd: worktree },
  );
  const records = raw.split(RECORD_SEP).filter((r) => r.replace(/^\n/, '').length > 0);
  const commits = records.map(parseLogRecord);
  const has_more = commits.length > limit;
  return { commits: commits.slice(0, limit), has_more };
}

const SHOW_FORMAT = `%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}%P${FIELD_SEP}%B`;

/**
 * A single commit's message and file changes. `diff-tree --root` makes the
 * initial commit list its files too (it has no parent to diff against
 * otherwise); its output always leads with the commit's own sha as a NUL
 * token before the status/path pairs, which we drop.
 */
export async function showCommit(worktree: string, sha: string): Promise<ShowCommitResponse> {
  const raw = await git(['show', '-s', `--format=${SHOW_FORMAT}`, sha], { cwd: worktree });
  const parts = raw.split(FIELD_SEP);
  const [hash, author_name, author_email, authored_at, subject, parentsRaw] = parts;
  const body = parts.slice(6).join(FIELD_SEP);
  const parents = parentsRaw && parentsRaw.length > 0 ? parentsRaw.split(' ') : [];

  const filesRaw = await git(['diff-tree', '-r', '--name-status', '-z', '--root', '-M', sha], {
    cwd: worktree,
  });
  const fileTokens = splitNulTokens(filesRaw);
  fileTokens.shift(); // the leading commit sha diff-tree always emits
  const files = parseStatusTokens(fileTokens);

  return {
    commit: {
      sha: hash ?? '',
      author_name: author_name ?? '',
      author_email: author_email ?? '',
      authored_at: authored_at ?? '',
      subject: subject ?? '',
      body,
    },
    parents,
    files,
  };
}

/**
 * Ahead/behind vs. the base branch plus a dirty-file count, for the session
 * detail view. ANY git failure (missing base, detached HEAD, a worktree that
 * vanished between the existence check and here) degrades to `null` — the
 * session detail must never 500 because of git.
 */
export async function gitSummary(
  worktree: string,
  baseBranch: string,
): Promise<{ ahead: number; behind: number; dirty_files: number } | null> {
  try {
    const ref = await resolveBaseRef(worktree, baseBranch);
    // left = commits reachable only from `ref` (behind), right = only from
    // HEAD (ahead) — verified empirically against a scratch repo, matching
    // rev-list's documented left-right semantics for `left...right`.
    const countsRaw = await git(['rev-list', '--left-right', '--count', `${ref}...HEAD`], {
      cwd: worktree,
    });
    const [behindStr, aheadStr] = countsRaw.split(/\s+/);
    const statusRaw = await git(['status', '--porcelain'], { cwd: worktree });
    const dirty_files = statusRaw.length === 0 ? 0 : statusRaw.split('\n').filter(Boolean).length;
    return { ahead: Number(aheadStr), behind: Number(behindStr), dirty_files };
  } catch {
    return null;
  }
}
