#!/bin/sh
# Internal puddled bootstrap — embedded in the CLI and desktop (SPEC §10).
#
# The launcher pipes this exact script locally or through its SSH master
# connection. It fetches daemon archives from GitHub Releases, including on
# first connection to a new host. It is not a public installer asset; public
# install.sh comes from scripts/install-cli.sh and installs the CLI only.
#
# Everything lands under ~/.puddle — never sudo. Idempotent: upgrade and
# rollback are the same script with a different --version.
#
# The launcher supplies --repo from its baked-in release repository; no owner
# slug lives in this template (CLAUDE.md conventions).
set -eu

REPO="${PUDDLE_REPO:-@@REPO@@}"
VERSION=""
TARBALL=""
SUMS=""
SUPERVISOR=1
START=1
FORCE=0
COMPONENT=daemon
SELECTOR=current
OTHER_SELECTOR=runtime-current
EXECUTABLE=puddled
STAGE_ONLY=0
SELECT_ONLY=0
ACTIVATE=""
STAGE_DIGEST=""
CHECKSUM_VERIFIED=0

usage() {
  cat <<'EOF'
usage: install.sh [--version X.Y.Z] [--tarball <path>] [--sums <path>]
                  [--repo owner/repo] [--no-supervisor] [--no-start] [--force]
                  [--component daemon|runtime]
                  [--stage-only | --activate-generation <name> --stage-digest <sha256>]

  --version       release to install (default: the repo's latest release)
  --tarball       use a pre-delivered tarball instead of fetching (scp
                  fallback and development); checksum verified when --sums
                  is given, otherwise skipped with a warning
  --sums          SHA256SUMS file accompanying --tarball
  --repo          GitHub repository to fetch from (or env PUDDLE_REPO)
  --no-supervisor unpack + symlink only
  --no-start      install the supervisor but do not start the daemon
  --force         reinstall even if this version is already present
  --component     select daemon (default) or the build for new runtimes;
                  runtime installation does not start or restart any service
  --stage-only    verify a fresh generation and emit its receipt without activation
  --select-only   activate an exact stage without changing supervisor configuration
                  or starting/restarting services (requires --activate-generation)
  --activate-generation
                  activate an exact previously staged generation, without fetching
  --stage-digest  expected staged receipt digest (requires --version and --component)
EOF
}

say() { printf '%s install: %s\n' "$EXECUTABLE" "$1"; }
die() { printf '%s install: error: %s\n' "$EXECUTABLE" "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --tarball) TARBALL="$2"; shift 2 ;;
    --sums) SUMS="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --no-supervisor) SUPERVISOR=0; shift ;;
    --no-start) START=0; shift ;;
    --force) FORCE=1; shift ;;
    --component) COMPONENT="$2"; shift 2 ;;
    --stage-only) STAGE_ONLY=1; shift ;;
    --select-only) SELECT_ONLY=1; shift ;;
    --activate-generation) ACTIVATE="$2"; shift 2 ;;
    --stage-digest) STAGE_DIGEST="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag $1 (see --help)" ;;
  esac
done
case "$COMPONENT" in
  daemon) ;;
  runtime) SELECTOR=runtime-current; OTHER_SELECTOR=current; EXECUTABLE=puddler ;;
  *) die "unknown host component: $COMPONENT" ;;
esac
if [ -n "$ACTIVATE" ]; then
  [ "$STAGE_ONLY" -eq 0 ] && [ "$FORCE" -eq 0 ] && [ -z "$TARBALL" ] && [ -z "$SUMS" ] \
    || die "activation cannot fetch, stage or force a repair"
  [ -n "$VERSION" ] || die "activation requires an exact version"
  case "$ACTIVATE" in ''|*[!0-9A-Za-z.+~_-]*) die "invalid staged generation" ;; esac
  printf '%s\n' "$ACTIVATE" | LC_ALL=C grep -Eq '^.+~[A-Za-z0-9]{6}$' \
    || die "invalid staged generation"
  [ "${#ACTIVATE}" -le 135 ] || die "staged generation is too long"
  [ "${#STAGE_DIGEST}" -eq 64 ] || die "activation requires a stage digest"
  case "$STAGE_DIGEST" in *[!0-9a-f]*) die "invalid stage digest" ;; esac
elif [ -n "$STAGE_DIGEST" ]; then
  die "a stage digest requires activation"
fi
if [ "$SELECT_ONLY" -eq 1 ]; then
  [ -n "$ACTIVATE" ] && [ "$SUPERVISOR" -eq 1 ] && [ "$START" -eq 1 ] \
    || die "selection-only requires exact activation without supervisor flags"
fi
if [ "$STAGE_ONLY" -eq 1 ]; then FORCE=1; fi

# --- platform ---------------------------------------------------------------
OS=$(uname -s)
case "$OS" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "unsupported OS $OS (linux and darwin only)" ;;
esac
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture $ARCH (x64 and arm64 only)" ;;
esac
if [ "$OS" = linux ] && [ -f /etc/alpine-release ]; then
  die "musl-based hosts (Alpine) are not supported: the bundled Node runtime needs glibc"
fi

HOME_DIR="${PUDDLE_HOME:-$HOME/.puddle}"
while [ "$HOME_DIR" != / ] && [ "${HOME_DIR%/}" != "$HOME_DIR" ]; do HOME_DIR=${HOME_DIR%/}; done
# New homes must be private even with umask 022. Existing releases used 0755;
# tighten only an owned directory that other users could not have modified.
# Keep this migration aligned with shared/node's initialisePrivateHome.
[ ! -L "$HOME_DIR" ] || die "Puddle home must not be a symlink: $HOME_DIR"
(umask 077; mkdir -p "$HOME_DIR")
case "$OS" in
  darwin) DIR_OWNER=$(stat -f '%u' "$HOME_DIR"); DIR_MODE=$(stat -f '%Lp' "$HOME_DIR") ;;
  linux) DIR_OWNER=$(stat -c '%u' "$HOME_DIR"); DIR_MODE=$(stat -c '%a' "$HOME_DIR") ;;
esac
[ "$DIR_OWNER" = "$(id -u)" ] || die "Puddle home must be owned by the current user: $HOME_DIR"
[ "$((0$DIR_MODE & 0022))" -eq 0 ] || die "Puddle home must not be writable by other users: $HOME_DIR"
chmod 700 "$HOME_DIR"
HOME_DIR=$(CDPATH= cd -- "$HOME_DIR" && pwd -P)
umask 077
BIN_DIR="$HOME_DIR/bin"
CACHE_DIR="$HOME_DIR/cache"
for DIRECTORY in "$BIN_DIR" "$BIN_DIR/versions" "$CACHE_DIR"; do
  [ ! -L "$DIRECTORY" ] || die "installation directory must not be a symlink: $DIRECTORY"
done
mkdir -p "$BIN_DIR/versions" "$CACHE_DIR" "$HOME_DIR/logs"
# Match the standalone CLI installer's fail-closed lock and fresh-tree pattern.
# This serialises bootstrap scripts; the durable host-update coordinator will
# additionally fence runtime admission and track replacement/adoption.
mkdir "$BIN_DIR/.install-lock" 2>/dev/null \
  || die "another installer is running (if interrupted, remove $BIN_DIR/.install-lock and retry)"
STAGE=""
WORK=""
cleanup() {
  if [ -n "$STAGE" ] && [ "$(readlink "$BIN_DIR/$SELECTOR" 2>/dev/null || true)" != "versions/$(basename "$STAGE")" ]; then
    rm -rf "$STAGE"
  fi
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  rmdir "$BIN_DIR/.install-lock"
}
trap cleanup 0
trap 'exit 1' 1 2 3 15
valid_version() {
  case "$VERSION" in ''|*[!0-9A-Za-z.+-]*) die "invalid release version: $VERSION" ;; esac
  [ "${#VERSION}" -le 128 ] && printf '%s\n' "$VERSION" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$' \
    || die "invalid release version: $VERSION"
}

# --- resolve version / fetch -------------------------------------------------
sha_tool() {
  if command -v sha256sum >/dev/null 2>&1; then echo "sha256sum -c -"
  elif command -v shasum >/dev/null 2>&1; then echo "shasum -a 256 -c -"
  else echo ""
  fi
}
prune_cache() {
  # Keep the current download and one previous archive; published trees stay intact.
  ls -1t "$CACHE_DIR"/puddled-v*.tar.gz 2>/dev/null | tail -n +3 | while read -r old; do rm -f "$old"; done
}

if [ -n "$ACTIVATE" ]; then
  : # The verified generation is already on this host; never fetch a replacement.
elif [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
  # Derive the version from the file name when not given explicitly.
  if [ -z "$VERSION" ]; then
    VERSION=$(basename "$TARBALL" | sed -n 's/^puddled-v\([0-9][^-]*\)-.*$/\1/p')
    [ -n "$VERSION" ] || die "cannot derive a version from $(basename "$TARBALL"); pass --version"
  fi

else
  case "$REPO" in *@@*) die "no repository baked in; pass --repo owner/repo or set PUDDLE_REPO" ;; esac
  command -v curl >/dev/null 2>&1 || die "curl is required to fetch releases (or pre-deliver with --tarball)"
  if [ -z "$VERSION" ]; then
    # GitHub redirects releases/latest to the tagged URL; capture the tag.
    LATEST=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
      || die "cannot reach github.com/$REPO to resolve the latest release"
    VERSION=$(printf '%s' "$LATEST" | sed -n 's#.*/tag/v\{0,1\}##p')
    [ -n "$VERSION" ] || die "could not resolve the latest release of $REPO; pass --version"
  fi
  valid_version
  FILE="puddled-v$VERSION-$OS-$ARCH.tar.gz"
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  TARBALL="$CACHE_DIR/$FILE"
  say "fetching $BASE/$FILE"
  curl -fSL --progress-bar -o "$TARBALL" "$BASE/$FILE" || die "download failed"
  curl -fsSL -o "$CACHE_DIR/SHA256SUMS" "$BASE/SHA256SUMS" || die "checksums download failed"
  SUMS="$CACHE_DIR/SHA256SUMS"
fi
valid_version
if [ -z "$ACTIVATE" ]; then
  # Resolve before changing directory, including SSH-delivered relative sums.
  TARBALL="$(CDPATH= cd -- "$(dirname "$TARBALL")" && pwd -P)/$(basename "$TARBALL")"
  if [ -n "$SUMS" ]; then
    SUMS="$(CDPATH= cd -- "$(dirname "$SUMS")" && pwd -P)/$(basename "$SUMS")"
  fi
  if [ "$STAGE_ONLY" -eq 1 ]; then
    WORK=$(mktemp -d "$BIN_DIR/.install-lock/stage.XXXXXX")
    cp "$TARBALL" "$WORK/$(basename "$TARBALL")"
    TARBALL="$WORK/$(basename "$TARBALL")"
    if [ -n "$SUMS" ]; then cp "$SUMS" "$WORK/SHA256SUMS"; SUMS="$WORK/SHA256SUMS"; fi
  fi
  if [ -n "$SUMS" ]; then
    TOOL=$(sha_tool)
    [ -n "$TOOL" ] || die "no sha256sum or shasum on this host to verify --sums"
    ( cd "$(dirname "$TARBALL")" && grep " $(basename "$TARBALL")\$" "$SUMS" | $TOOL ) \
      || die "checksum mismatch for $TARBALL"
    CHECKSUM_VERIFIED=1
  else
    say "warning: --tarball without --sums — checksum verification skipped"
  fi
fi

# --- unpack + symlink flip ---------------------------------------------------
smoke() {
  "$1/bin/node" --input-type=commonjs - "$1" "$EXECUTABLE" "$VERSION" "$STAGE_ONLY" "$ACTIVATE" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const [root, executable, version, stageOnly, activate] = process.argv.slice(2);
let expected;
if (executable === 'puddler' || stageOnly === '1' || activate) {
  const file = path.join(root, executable === 'puddler' ? 'RUNTIME_PROTOCOL' : 'PROTOCOL');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 33) throw Error('Invalid runtime protocol metadata');
  const protocol = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9]+\.[0-9]+$/.test(protocol) || !protocol.split('.').every((part) => Number.isSafeInteger(Number(part))))
    throw Error('Invalid runtime protocol metadata');
  expected = `${executable} ${version} (${executable === 'puddler' ? 'runtime protocol' : 'protocol'} ${protocol})`;
}
const result = spawnSync(path.join(root, executable), ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
if (result.error || result.status !== 0 || (expected !== undefined && result.stdout.trim() !== expected)) {
  process.stderr.write(String(result.error || result.stderr || 'Version smoke test failed'));
  process.exit(1);
}
NODE
}
DEST=""
SMOKE_LOG="$HOME_DIR/logs/install-smoke.log"
NEED_INSTALL=1
# Reuse a selected generation (both components can share it), or a legacy
# fixed-version tree. Never repair either in place: a runtime, helper, daemon or
# connector may still pin it.
if [ -n "$ACTIVATE" ]; then
  DEST="$BIN_DIR/versions/$ACTIVATE"
  [ -d "$DEST" ] && [ ! -L "$DEST" ] || die "staged generation is missing"
  [ "$(head -c 130 "$DEST/VERSION")" = "$VERSION" ] || die "staged version mismatch"
  NEED_INSTALL=0
else
  for CANDIDATE in "$SELECTOR" "$OTHER_SELECTOR"; do
    CURRENT=$(readlink "$BIN_DIR/$CANDIDATE" 2>/dev/null || true)
    case "$CURRENT" in
      versions/*)
        NAME=${CURRENT#versions/}
        case "$NAME" in
          ''|.|..|*/*) ;;
          *)
            if [ -f "$BIN_DIR/$CURRENT/VERSION" ] && [ "$(head -c 130 "$BIN_DIR/$CURRENT/VERSION")" = "$VERSION" ]; then
              DEST="$BIN_DIR/$CURRENT"
            fi ;;
        esac ;;
    esac
    [ -z "$DEST" ] || break
  done
  if [ -z "$DEST" ]; then DEST="$BIN_DIR/versions/$VERSION"; fi
  if [ -d "$DEST" ] && [ ! -L "$DEST" ] && [ "$FORCE" -eq 0 ] && [ -x "$DEST/$EXECUTABLE" ] \
    && { [ ! -e "$DEST/VERSION" ] || [ "$(head -c 130 "$DEST/VERSION")" = "$VERSION" ]; }; then
    if smoke "$DEST" >/dev/null 2>"$SMOKE_LOG"; then
      NEED_INSTALL=0
      rm -f "$SMOKE_LOG"
      say "version $VERSION already installed"
    else
      say "existing version $VERSION failed validation — staging a new generation"
    fi
  fi
  if [ "$NEED_INSTALL" -eq 1 ]; then
    # '~' cannot be mistaken for part of a legacy release/prerelease version.
    STAGE=$(mktemp -d "$BIN_DIR/versions/$VERSION~XXXXXX")
    DEST="$STAGE"
    tar -xzf "$TARBALL" --strip-components=1 -C "$DEST" || die "extraction failed"
    [ -f "$DEST/VERSION" ] && [ "$(head -c 130 "$DEST/VERSION")" = "$VERSION" ] \
      || die "archive version metadata mismatch"
    if ! smoke "$DEST" >/dev/null 2>"$SMOKE_LOG"; then
      die "installed tree fails its own --version smoke test (details: $SMOKE_LOG)"
    fi
    rm -f "$SMOKE_LOG"
  fi
fi
if [ "$STAGE_ONLY" -eq 1 ] || [ -n "$ACTIVATE" ]; then
  # The immutable receipt binds the complete tree, including native dependencies
  # and symlink targets. Activation verifies it without resolving another release.
  RECEIPT=$("$DEST/bin/node" --input-type=commonjs - "$DEST" "$COMPONENT" "$VERSION" "$TARBALL" "$CHECKSUM_VERIFIED" "$STAGE_ONLY" "$STAGE_DIGEST" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [root, component, version, archive, verified, stageOnly, expectedDigest] = process.argv.slice(2);
const marker = '.puddle-stage.json';
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const deadline = Date.now() + 30_000;
let files = 0, bytes = 0;
const check = () => {
  if (files > 100_000 || bytes > 2 * 1024 ** 3 || Date.now() > deadline) throw Error('Stage verification limit exceeded');
};
async function contents(file, hash) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || bytes + stat.size > 2 * 1024 ** 3) throw Error('Stage verification limit exceeded');
  for await (const chunk of fs.createReadStream(file)) {
    bytes += chunk.length;
    check();
    hash.update(chunk);
  }
}
async function tree(directory, relative, hash) {
  const entries = (await fs.promises.readdir(directory)).sort();
  for (const entry of entries) {
    if (!relative && entry === marker) continue;
    files++;
    check();
    const name = relative ? relative + '/' + entry : entry;
    const file = path.join(directory, entry);
    const stat = await fs.promises.lstat(file);
    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : null;
    if (!type) throw Error('Unsupported staged file type');
    hash.update(JSON.stringify([name, type, stat.mode & 0o777, stat.isFile() ? stat.size : null]));
    if (stat.isDirectory()) await tree(file, name, hash);
    else if (stat.isFile()) await contents(file, hash);
    else hash.update(await fs.promises.readlink(file));
    hash.update('\0');
    const after = await fs.promises.lstat(file);
    if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      throw Error('Staged tree changed during verification');
  }
}
async function main() {
  const before = fs.lstatSync(root);
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(['', 'directory', before.mode & 0o777, null]));
  await tree(root, '', hash);
  const after = fs.lstatSync(root);
  if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw Error('Staged tree changed during verification');
  const treeDigest = hash.digest('hex');
  const file = path.join(root, marker);
  if (stageOnly !== '1') {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let body;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw Error('Invalid stage receipt');
      const buffer = Buffer.alloc(4097);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (size > 4096) throw Error('Stage receipt exceeds its limit');
      body = buffer.subarray(0, size);
    } finally { fs.closeSync(fd); }
    if (digest(body) !== expectedDigest) throw Error('Stage receipt digest mismatch');
    const record = JSON.parse(body.toString('utf8'));
    if (record.format !== 1 || record.generation !== path.basename(root) || record.component !== component || record.version !== version || record.tree_sha256 !== treeDigest)
      throw Error('Staged release no longer matches its receipt');
    return;
  }
  const protocolFile = path.join(root, component === 'runtime' ? 'RUNTIME_PROTOCOL' : 'PROTOCOL');
  const stat = fs.lstatSync(protocolFile);
  if (!stat.isFile() || stat.size > 33) throw Error('Invalid stage protocol metadata');
  const match = /^(\d+)\.(\d+)$/.exec(fs.readFileSync(protocolFile, 'utf8').trim());
  if (!match || !match.slice(1).every((part) => Number.isSafeInteger(Number(part)))) throw Error('Invalid stage protocol metadata');
  const archiveHash = crypto.createHash('sha256');
  await contents(archive, archiveHash);
  const record = {
    format: 1, component, generation: path.basename(root), version,
    protocol: { major: Number(match[1]), minor: Number(match[2]) },
    archive_sha256: archiveHash.digest('hex'), tree_sha256: treeDigest,
    checksum_verified: verified === '1',
  };
  const body = JSON.stringify(record) + '\n';
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (const directory of [root, path.dirname(root)]) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  process.stdout.write(JSON.stringify({ record, digest: digest(body) }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE
  ) || die "staged release verification failed"
  if [ "$STAGE_ONLY" -eq 1 ]; then
    STAGE="" # Durable stage survives a lost reply; it is never selected implicitly.
    prune_cache
    printf 'PUDDLE_HOST_STAGE %s\n' "$RECEIPT"
    exit 0
  fi
  if ! smoke "$DEST" >/dev/null 2>"$SMOKE_LOG"; then
    die "staged tree fails its own --version smoke test (details: $SMOKE_LOG)"
  fi
  rm -f "$SMOKE_LOG"
fi
# Use the archive's Node as the standalone CLI installer does: rename replaces
# the symlink itself atomically on both platforms, without following it as mv
# can. Publish the wrapper first; an unsuccessful activation retains current.
"$DEST/bin/node" --input-type=commonjs - "$BIN_DIR" "$DEST" "$SELECTOR" "$EXECUTABLE" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [root, destination, selector, executable] = process.argv.slice(2);
const current = path.join(root, selector);
try {
  if (!fs.lstatSync(current).isSymbolicLink()) throw Error(selector + ' must be a symlink');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const launcher = path.join(root, executable);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
// The archive launcher resolves its own directory; retain an exec wrapper.
const wrapper = '#!/bin/sh\nexec ' + quote(path.join(current, executable)) + ' "$@"\n';
const suffix = '.new-' + process.pid;
try {
  const fd = fs.openSync(launcher + suffix, 'wx', 0o755);
  try { fs.writeFileSync(fd, wrapper); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.symlinkSync(path.relative(root, destination), current + suffix);
  fs.renameSync(launcher + suffix, launcher);
  fs.renameSync(current + suffix, current);
  const directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
} finally {
  fs.rmSync(launcher + suffix, { force: true });
  fs.rmSync(current + suffix, { force: true });
}
NODE
STAGE="" # Published generations are retained until reference-aware collection.

prune_cache

if [ "$SELECT_ONLY" -eq 1 ]; then
  say "selected $COMPONENT $VERSION (supervisor configuration and services unchanged)"
  exit 0
fi

if [ "$COMPONENT" = runtime ]; then
  say "selected runtime $VERSION for new launches (existing services unchanged)"
  exit 0
fi

if [ "$SUPERVISOR" -eq 0 ]; then
  printf '%s\n' none > "$HOME_DIR/supervisor"
  say "installed puddled $VERSION (no supervisor, per --no-supervisor)"
  exit 0
fi

# --- supervisor: systemd user unit → launchd agent → nohup fallback ----------
KIND=none
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  KIND=systemd
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/puddled.service" <<EOF
[Unit]
Description=puddle daemon (puddled)
After=network.target

[Service]
ExecStart=%h/.puddle/bin/current/puddled
Restart=always
RestartSec=2
WorkingDirectory=%h
Environment=NODE_ENV=production
# systemd gives a bare PATH; add the dirs agent CLIs install to (Claude Code's
# ~/.local/bin) so the daemon can spawn them (SPEC §5). Also configurable at
# runtime via config.json's agentPath.
Environment=PATH=%h/.local/bin:%h/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  if [ "$START" -eq 1 ]; then
    systemctl --user enable --now puddled >/dev/null 2>&1 || die "systemctl enable --now puddled failed"
    systemctl --user restart puddled
  else
    systemctl --user enable puddled >/dev/null 2>&1 || true
  fi
  # Boot-start without an open login session; may need polkit auth on some
  # distros — a warning, not a failure.
  loginctl enable-linger "$USER" >/dev/null 2>&1 \
    || say "warning: loginctl enable-linger failed — puddled will not start at boot until a login"
elif [ "$OS" = darwin ]; then
  KIND=launchd
  PLIST="$HOME/Library/LaunchAgents/dev.puddle.puddled.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.puddle.puddled</string>
  <key>ProgramArguments</key><array><string>$HOME/.puddle/bin/current/puddled</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>$HOME</string>
  <!-- launchd gives a bare PATH; add the dirs agent CLIs install to (Claude
       Code's ~/.local/bin, Homebrew) so the daemon can spawn them (SPEC §5).
       Also configurable at runtime via config.json's agentPath. -->
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$HOME/.puddle/logs/puddled.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.puddle/logs/puddled.err.log</string>
</dict></plist>
EOF
  if [ "$START" -eq 1 ]; then
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
    # Restart onto the new version whether or not it was already loaded.
    launchctl kickstart -k "gui/$(id -u)/dev.puddle.puddled" 2>/dev/null || true
  fi
else
  KIND=nohup
  if [ "$START" -eq 1 ]; then
    if [ -f "$HOME_DIR/puddled.pid" ] && kill -0 "$(cat "$HOME_DIR/puddled.pid")" 2>/dev/null; then
      kill "$(cat "$HOME_DIR/puddled.pid")" || true
      sleep 1
    fi
    nohup "$BIN_DIR/current/puddled" >> "$HOME_DIR/logs/puddled.out.log" 2>&1 &
    printf '%s\n' "$!" > "$HOME_DIR/puddled.pid"
  fi
  say "warning: no systemd or launchd found — using nohup; puddled will NOT auto-start after a reboot"
fi

printf '%s\n' "$KIND" > "$HOME_DIR/supervisor"
# An upgrade replaces the supervised connector too. Never opt a new host in.
if [ "$START" = 1 ] && [ -d "$HOME_DIR/remote" ]; then
  if [ "$KIND" = systemd ] && [ -f "$HOME/.config/systemd/user/puddle-connector.service" ]; then
    systemctl --user restart puddle-connector || die "connector restart failed"
  elif [ "$KIND" = launchd ] && [ -f "$HOME/Library/LaunchAgents/dev.puddle.connector.plist" ]; then
    launchctl kickstart -k "gui/$(id -u)/dev.puddle.connector" 2>/dev/null || die "connector restart failed"
  fi
fi
say "installed puddled $VERSION under $HOME_DIR (supervisor: $KIND)"
