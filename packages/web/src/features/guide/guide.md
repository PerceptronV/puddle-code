# Puddle Guide

## Contents

- [CLI installation](#cli-installation)
- [Installing and managing Puddle components](#installing-and-managing-puddle-components)
- [What are the CLI, daemon and desktop app?](#what-are-the-cli-daemon-and-desktop-app)
- [How do I remove the CLI?](#how-do-i-remove-the-cli)
- [Pedantic details](#pedantic-details)

## CLI installation

There are two ways to install the `puddle` CLI.

1. If you already use Node.js 22 or newer:

   ```sh
   npm install -g @puddle-code/cli
   ```

2. For a standalone installation without Node.js or npm:

   ```sh
   curl -fsSL {{APP_ORIGIN}}/install.sh | sh
   ```

   By default, this installs the CLI under `~/.local/share/puddle/cli` and its launcher at `~/.local/bin/puddle`. The installation directory honours `XDG_DATA_HOME` and `PUDDLE_CLI_HOME` when set.

   > [!NOTE]
   > The standalone CLI supports macOS on Apple silicon and Linux on x64 or arm64. Linux needs glibc 2.28 or newer; Alpine is not supported. The installer downloads a bundled Node runtime and verifies the release archive's checksum.
   >
   > If the installer says that directory is missing from your `PATH`, add this line to your shell's startup file, then open a new terminal:
   >
   > ```sh
   > export PATH="$HOME/.local/bin:$PATH"
   > ```

After either installation, check it with:

```sh
puddle --version
```

This lists the installed CLI, daemon, default runtime and desktop versions and their protocol versions. Missing components are reported as not installed.

## Installing and managing Puddle components

The master commands are:

```sh
puddle install <daemon|runtime|desktop>[@version] [user@host]
puddle upgrade [cli|daemon|runtime|desktop][@version] [user@host]
puddle remove  <cli|daemon|desktop> [user@host]
```

Square brackets describe optional arguments, angle brackets mark a required choice, and `|` means “choose one”; do not type them literally. An SSH destination applies to daemon and runtime components. The CLI and desktop are managed on your current machine. `puddle install cli` is not a command: use npm or `install.sh` for the initial CLI installation.

For example:

- In order to install the desktop app, run:

  ```sh
  puddle install desktop
  ```

- In order to install the daemon on `user@host`, run:

  ```sh
  puddle install daemon user@host
  ```

- In order to upgrade installed local components, run:

  ```sh
  puddle upgrade
  ```

  This upgrades the installed local daemon and runtime default, then the installed macOS desktop app, then the CLI. Quit the desktop app first. Missing host/desktop installations are skipped, and remote hosts are not updated by this command.

- In order to upgrade only the CLI, run:

  ```sh
  puddle upgrade cli
  ```

- In order to upgrade the desktop app on macOS, quit it and run:

  ```sh
  puddle upgrade desktop
  ```

- In order to upgrade or remove a remote daemon, run:

  ```sh
  puddle upgrade daemon user@host
  puddle remove daemon user@host
  ```

  Omit `user@host` to manage the local daemon. Upgrade and removal restart or stop the daemon, interrupting its live processes. Removal asks for confirmation and keeps host data by default; only agree to the separate data-deletion prompt, or use `--purge`, if you want to delete it too.

- In order to remove the desktop app on macOS, quit it and run:

  ```sh
  puddle remove desktop
  ```

  This asks for confirmation and leaves daemons and their data in place.

- In order to update the default runtime software on a connected host, run:

  ```sh
  puddle upgrade runtime user@host
  puddle updates user@host
  ```

  Omit `user@host` for this machine. This changes the `puddler` build used by future launches; existing runtimes keep their pinned build and running processes. It requires a running daemon with host-update support (application protocol 25.7+) and an available user service manager. `install runtime` keeps an existing default unless you name a version. Local archive installation requires an explicit `runtime@X.Y.Z` and a verified checksum file beside the archive.

  If a connection is lost, inspect the printed operation id with `puddle updates user@host --operation <id>`. To abandon a preparation before dispatch, add `--cancel` with that complete id. An accepted update cannot be cancelled or replayed. A `recovery_required` result remains visible for inspection; it is not reported as a successful installation.

  Status inspection also works when the daemon cannot connect: the CLI labels the result as recorded update state and reads it directly through your local or SSH access. This does not start the daemon or change the update. Cancellation and recovery still require a live daemon connection.

  With a running daemon supporting application protocol 25.11+, use `puddle updates user@host --operation <id> --recover` to verify an installation which completed but lost its success reply. This checks that the updater and its commands have ended and verifies the selected software and runtime adoption. It never repeats installation or service commands. An incomplete installation, unavailable daemon or unconfirmed updater lifetime stays pending; this command does not restart a stopped daemon or roll back data.

> [!NOTE]
> On Linux, `puddle install desktop` asks where to put `Puddle.AppImage`, defaulting to `~/puddle`. Update from inside the app and remove it by quitting and deleting the AppImage file. CLI desktop upgrade/removal is available only on macOS. Desktop releases cover macOS on Apple silicon and Linux x64.

`install` keeps an existing installation unless you name a version. `upgrade` selects the newest release or the named version; explicit daemon upgrades and macOS desktop upgrades also install a missing component. For example, `puddle upgrade cli@X.Y.Z` selects a published CLI version, including an older one. Keep CLI and daemon protocol versions compatible when pinning versions.

## What are the CLI, daemon and desktop app?

- **CLI (`puddle`):** the frontend. It installs and manages Puddle components, opens the browser UI, and launches connections to local or SSH hosts.
- **Desktop app:** provides the same workspace UI in a native application window, with local and SSH connections. Component-management commands live in the CLI.
- **Daemon (`puddled`):** the backend. It runs on the host machine, communicates with the CLI/desktop frontends, owns live terminal and agent processes, and saves session state and Git worktrees on disk. Saved state survives restarts; live processes do not.

The daemon and desktop can run standalone without the CLI, but the CLI makes it easy to manage upgrades and installations.

## How do I remove the CLI?

Stop its background browser workspaces with `puddle kill --all`, then run:

```sh
puddle remove cli
```

This asks for confirmation and removes the standalone installation or uninstalls
the npm package, depending on how you installed it. Daemons, the desktop app and
host data remain. If you want to remove those components too, use their CLI
removal commands before removing the CLI itself.

## Pedantic details

1. `puddle upgrade cli` keeps the CLI's installation method:

   - **Installed with npm:** runs `npm install -g @puddle-code/cli@latest`. npm must
     still be available in your terminal.
   - **Installed with `install.sh`:** uses its embedded installer to fetch and
     verify the latest GitHub release. It keeps your installation directory and
     launcher location, and needs no npm.

   If you have both installations, `command -v puddle` shows which one your shell
   uses. The running CLI determines the upgrade method.

2. Standalone CLI upgrades use the embedded installer, so they do not fetch the website's `install.sh` again. The hosted script resolves the latest release each time it runs; the deployment does not need updating for every release, only when the installer itself changes. npm and GitHub are separate release sources, so their latest published versions can differ.

3. Daemon install/upgrade commands try to resolve the latest GitHub release. If the release API is unavailable, they warn and fall back to the version pinned by the running CLI. Automatic bootstrap when opening a workspace uses that pinned version. Naming `@version` explicitly overrides version selection.
