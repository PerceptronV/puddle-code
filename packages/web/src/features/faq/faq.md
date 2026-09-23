# FAQs

## What are the CLI, daemon and desktop app?

- **CLI (`puddle`):** installs and manages Puddle components, opens the browser
  interface, and connects to local or SSH hosts.
- **Daemon (`puddled`):** runs on the machine where your projects and agents live.
  It owns their processes, worktrees and session state.
- **Desktop app:** provides the same UI functionality as `puddle` in a native window.

Each component may be run standalone, but daemon and desktop installations must be managed through the CLI.

## How do I install the CLI?

For a standalone installation without Node.js or npm:

```sh
curl -fsSL {{APP_ORIGIN}}/install.sh | sh
```

This installs the CLI under `~/.local/share/puddle/cli` and its launcher at
`~/.local/bin/puddle`. If the installer says that directory is missing from
your `PATH`, add this line to your shell's startup file, then open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

The standalone CLI supports macOS on Apple silicon and Linux on x64 or arm64.
Linux needs glibc 2.28 or newer; Alpine is not supported. The installer downloads
a bundled Node runtime and verifies the release archive's checksum.

If you already use Node.js 22 or newer, npm is another option:

```sh
npm install -g @puddle-code/cli
```

Check your installation with:

```sh
puddle --version
```

This lists the installed CLI, daemon and desktop versions, together with their
protocol versions. It is normal for the daemon and desktop to be absent initially.

## How do I upgrade the CLI?

```sh
puddle upgrade cli
```

The CLI keeps its installation method:

- **Installed with npm:** runs `npm install -g @puddle-code/cli@latest`. npm must
  still be available in your terminal.
- **Installed with `install.sh`:** uses its embedded installer to fetch and
  verify the latest GitHub release. It keeps your installation directory and
  launcher location, and needs no npm.

Standalone upgrades do not fetch this website's installer again. npm and GitHub
are separate release sources, so their latest versions depend on what has been
published to each.

If you have both installations, `command -v puddle` shows which one your shell
uses. The running CLI determines the upgrade method.

## What does `puddle upgrade` update?

```sh
puddle upgrade
```

This upgrades the installed local daemon, then the installed macOS desktop app,
then the CLI. Quit the desktop app first. Components that are not installed are
skipped; the CLI upgrades last using its existing installation method.

Linux desktop updates happen inside the app. To upgrade only a remote daemon:

```sh
puddle upgrade daemon user@host
```

## How do I install, upgrade or remove the desktop app?

Install it on your current machine:

```sh
puddle install desktop
```

On **macOS**, Puddle installs into `/Applications` when writable, otherwise
`~/Applications`. Quit the app before upgrading or removing it:

```sh
puddle upgrade desktop
puddle remove desktop
```

Removal asks for confirmation. It leaves your daemons and their data in place.
You can also use the desktop app's update notification while it is running.

On **Linux**, installation asks where to put `Puddle.AppImage`, defaulting to
`~/puddle`. Update through the app's update notification. To remove it, quit the
app and delete that AppImage file; CLI desktop upgrade/removal is not available
on Linux.

Desktop releases currently cover macOS on Apple silicon and Linux x64.
Desktop installation always targets your current machine; it does not take an
SSH destination.

## How do I install, upgrade or remove a daemon?

For the daemon on your current machine:

```sh
puddle install daemon
puddle upgrade daemon
puddle remove daemon
```

For a remote machine:

```sh
puddle install daemon user@host
puddle upgrade daemon user@host
puddle remove daemon user@host
```

`install` leaves an existing installation in place unless you name a version.
`upgrade` installs the newest release, including when the component is missing.
Upgrading restarts the daemon and can interrupt live agent processes.

Removal asks for confirmation, stops the daemon and removes its managed
installation. It keeps the host's `~/.puddle` data by default, including profiles,
session history and worktrees. Keep that data if you plan to reinstall later.

To request deletion of the data as well, use `puddle remove daemon --purge`
(or `puddle remove daemon user@host --purge`). The CLI asks for confirmation and
checks worktrees for uncommitted or unpushed work. Purging deletes that host's
Puddle data; it is not needed for a normal upgrade or reinstall.

## Do I need to install a daemon before connecting?

No. Launching a workspace installs a missing daemon automatically:

```sh
puddle launch
puddle launch user@host
```

The first command opens a local workspace; the second connects over SSH.
Puddle uses your system `ssh`, including its configuration, keys and jump hosts.
The embedded daemon bootstrap fetches checksum-verified archives from GitHub
Releases. There is no separate public daemon installation script.

If a host has an older, incompatible daemon protocol, the launcher asks before
updating it and shows how many live sessions the restart would interrupt.

## Can I install a specific version?

Replace `X.Y.Z` with a published version:

```sh
puddle upgrade cli@X.Y.Z
puddle install desktop@X.Y.Z
puddle install daemon@X.Y.Z user@host
```

The version must exist for your platform and installation method. Naming a
version can downgrade a component. Keep the CLI and daemon on compatible
protocol versions; otherwise a later connection may request an update or refuse
to connect.

For a first standalone CLI installation at a specific version:

```sh
curl -fsSL {{APP_ORIGIN}}/install.sh | sh -s -- --version X.Y.Z
```

## How do I remove the CLI?

Close its browser workspaces, then run:

```sh
puddle remove cli
```

This asks for confirmation and removes the standalone installation or uninstalls
the npm package, depending on how you installed it. Daemons, the desktop app and
host data remain. If you want to remove those components too, use their CLI
removal commands before removing the CLI itself.
