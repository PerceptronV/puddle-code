#!/bin/sh
# puddled installer — the single bootstrap implementation (SPEC §10).
#
# Runs three ways, always with the same steps:
#   1. curl-piped:   curl -fsSL .../install.sh | sh -s -- --version 0.1.0
#   2. by the puddle CLI over SSH (the CLI embeds this exact script and pipes
#      it through the master connection: ssh host 'sh -s -- ...')
#   3. by hand, for daemon-only installs without the CLI.
#
# Everything lands under ~/.puddle — never sudo. Idempotent: upgrade and
# rollback are the same script with a different --version.
#
# The committed template carries @@REPO@@; the release workflow substitutes
# the publishing repository before attaching this file to the release, so no
# owner slug lives in the repo (CLAUDE.md conventions). Running the template
# directly requires --repo or PUDDLE_REPO=owner/repo.
set -eu

REPO="${PUDDLE_REPO:-@@REPO@@}"
VERSION=""
TARBALL=""
SUMS=""
SUPERVISOR=1
START=1
FORCE=0

usage() {
  cat <<'EOF'
usage: install.sh [--version X.Y.Z] [--tarball <path>] [--sums <path>]
                  [--repo owner/repo] [--no-supervisor] [--no-start] [--force]

  --version       release to install (default: the repo's latest release)
  --tarball       use a pre-delivered tarball instead of fetching (scp
                  fallback and development); checksum verified when --sums
                  is given, otherwise skipped with a warning
  --sums          SHA256SUMS file accompanying --tarball
  --repo          GitHub repository to fetch from (or env PUDDLE_REPO)
  --no-supervisor unpack + symlink only
  --no-start      install the supervisor but do not start the daemon
  --force         reinstall even if this version is already present
EOF
}

say() { printf 'puddled install: %s\n' "$1"; }
die() { printf 'puddled install: error: %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --tarball) TARBALL="$2"; shift 2 ;;
    --sums) SUMS="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --no-supervisor) SUPERVISOR=0; shift ;;
    --no-start) START=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag $1 (see --help)" ;;
  esac
done

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
BIN_DIR="$HOME_DIR/bin"
CACHE_DIR="$HOME_DIR/cache"
mkdir -p "$BIN_DIR/versions" "$CACHE_DIR" "$HOME_DIR/logs"

# --- resolve version / fetch -------------------------------------------------
sha_tool() {
  if command -v sha256sum >/dev/null 2>&1; then echo "sha256sum -c -"
  elif command -v shasum >/dev/null 2>&1; then echo "shasum -a 256 -c -"
  else echo ""
  fi
}

if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
  # Derive the version from the file name when not given explicitly.
  if [ -z "$VERSION" ]; then
    VERSION=$(basename "$TARBALL" | sed -n 's/^puddled-v\([0-9][^-]*\)-.*$/\1/p')
    [ -n "$VERSION" ] || die "cannot derive a version from $(basename "$TARBALL"); pass --version"
  fi
  if [ -n "$SUMS" ]; then
    TOOL=$(sha_tool)
    [ -n "$TOOL" ] || die "no sha256sum or shasum on this host to verify --sums"
    ( cd "$(dirname "$TARBALL")" && grep " $(basename "$TARBALL")\$" "$SUMS" | $TOOL ) \
      || die "checksum mismatch for $TARBALL"
  else
    say "warning: --tarball without --sums — checksum verification skipped"
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
  FILE="puddled-v$VERSION-$OS-$ARCH.tar.gz"
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  TARBALL="$CACHE_DIR/$FILE"
  say "fetching $BASE/$FILE"
  curl -fSL --progress-bar -o "$TARBALL" "$BASE/$FILE" || die "download failed"
  curl -fsSL -o "$CACHE_DIR/SHA256SUMS" "$BASE/SHA256SUMS" || die "checksums download failed"
  TOOL=$(sha_tool)
  [ -n "$TOOL" ] || die "no sha256sum or shasum on this host"
  ( cd "$CACHE_DIR" && grep " $FILE\$" SHA256SUMS | $TOOL ) || {
    rm -f "$TARBALL"
    die "checksum mismatch — deleted the download"
  }
fi

# --- unpack + symlink flip ---------------------------------------------------
DEST="$BIN_DIR/versions/$VERSION"
if [ -d "$DEST" ] && [ "$FORCE" -eq 0 ] && [ -x "$DEST/puddled" ]; then
  say "version $VERSION already installed"
else
  rm -rf "$DEST"
  mkdir -p "$DEST"
  tar -xzf "$TARBALL" --strip-components=1 -C "$DEST" || die "extraction failed"
  "$DEST/puddled" --version >/dev/null || die "installed tree fails its own --version smoke test"
fi
ln -sfn "versions/$VERSION" "$BIN_DIR/current"

# ~/.puddle/bin/puddled must be an exec wrapper, NOT a symlink: the launcher
# locates bin/node via dirname $0, which must land inside current/.
printf '#!/bin/sh\nexec "%s/current/puddled" "$@"\n' "$BIN_DIR" > "$BIN_DIR/puddled"
chmod 0755 "$BIN_DIR/puddled"

# Keep the cache small: current download + one previous.
ls -1t "$CACHE_DIR"/puddled-v*.tar.gz 2>/dev/null | tail -n +3 | while read -r old; do rm -f "$old"; done

if [ "$SUPERVISOR" -eq 0 ]; then
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

say "installed puddled $VERSION under $HOME_DIR (supervisor: $KIND)"
