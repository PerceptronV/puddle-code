# Puddle Guide

## Contents

- [CLI installation](#cli-installation)
- [Installing and managing Puddle components](#installing-and-managing-puddle-components)
- [Updating a host from a paired browser](#updating-a-host-from-a-paired-browser)
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

  Omit `user@host` to manage the local daemon. Upgrade and removal restart or stop the daemon. Independent runtimes can keep running; review any separately listed daemon-owned work before agreeing to interruption. Removal asks for confirmation and keeps host data by default; only agree to the separate data-deletion prompt, or use `--purge`, if you want to delete it too.

- In order to remove the desktop app on macOS, quit it and run:

  ```sh
  puddle remove desktop
  ```

  This asks for confirmation and leaves daemons and their data in place.

- In a local or SSH cockpit, open **Settings → Host → Updates** to inspect the daemon and runtime builds. Supporting hosts offer **Prepare daemon**, **Prepare runtime software** and **Prepare both** for a newer release. Preparation downloads and verifies the software; select **Review impact**, then explicitly apply it. If daemon-owned work must stop, the review lists the affected work and requires a separate interruption action. Existing persistent runtimes retain their processes and pinned builds. Each new window offers available updates again; dismissing an offer keeps the actions in Settings. Older hosts still need the CLI upgrade below before these controls are available.

  After installing a new cockpit, daemon or runtime release, its release notes open as a Markdown preview. The preview shows the corresponding **Cockpit**, **Daemon** or **Runtime** sections together when they share a release. The remote application also shows its **Remote** section. Notes describe installed software, including the runtime default for future launches; downloading an update alone does not open them. Read notes stay dismissed across reconnects in that browser, and a newer installed release opens its own notes.

  If the daemon disconnects, the cockpit can show the host's recorded update status and its last change time. Recorded completion does not confirm current service health or runtime adoption. For an unfinished update with supporting staged software, **Continue recovery on host** checks the host and continues pending steps. Keep the window open until the host accepts the request; accepted recovery runs independently. Refresh status after a lost response—the cockpit never repeats the action automatically. Older staged software still needs the CLI recovery commands below.

- In order to update the default runtime software on a connected host from the CLI, run:

  ```sh
  puddle upgrade runtime user@host
  puddle updates user@host
  ```

  Omit `user@host` for this machine. This changes the `puddler` build used by future launches; existing runtimes keep their pinned build and running processes. It requires a running daemon with host-update support (application protocol 25.7+) and an available user service manager. `install runtime` keeps an existing default unless you name a version. Local archive installation requires an explicit `runtime@X.Y.Z` and a verified checksum file beside the archive.

  On hosts without a usable user service manager, runtimes have a limited host-session lifetime. Closing an SSH cockpit stops its attached daemon; the host may retain or reap its independent runtimes. Reconnecting adopts survivors and restores interrupted sessions according to the host’s auto-resume setting. Daemon replacement is blocked while limited runtimes run, and managed host updates require a supported service manager.

  To move an existing runtime onto the installed build, open its session menu → **Runtime…** in a local or SSH cockpit. Review its build, target build and affected terminals, then choose **Restart on …**. This stops only that runtime, loses its shell jobs and process state, closes extra shell tabs and resumes the exact native conversation (or opens a fresh main shell for a terminal session). Unknown or changed runtime state requires another inspection. A software update alone never performs this restart.

  `puddle upgrade daemon user@host` uses the same update coordinator on supporting hosts. Independently hosted agents keep running. If preflight identifies daemon-owned terminals, notebook kernels, compilation tasks or programmes that must stop, the CLI asks for explicit approval in an interactive terminal. Declining keeps the stage available without activating it. First installs and upgrades from older daemon-owned sessions still use the embedded installer and report the interruption count.

  On supporting hosts, `puddle install daemon user@host` also restores a recorded, completed service removal using its retained release and configuration. An unfinished removal must be resolved first. Repeating install observes a completed restoration and reconnects without restarting an already-running daemon.

  On persistent-runtime hosts, `puddle remove daemon user@host` disables remote access and stops daemon-owned work, then offers a choice to retain or stop independent runtimes. `--yes` retains them by default; add `--stop-runtimes` to explicitly stop the reviewed runtimes and their shell jobs. Data and pinned releases remain for reinstallation. There is no separate `remove runtime` command: runtime ownership is standard functionality, and eligible unused software is collected only after its references are retired.

  `--purge` separately requests deletion of managed host data on supporting persistent-runtime hosts (introduced in application 25.20; the daemon must match the CLI’s application major) and requires runtime-stop consent (`--yes --purge --stop-runtimes` for non-interactive use). After removal, reboot the target and rerun the explicit purge command. Puddle checks for uncommitted or unpushed work before deleting the reviewed data in resumable batches. Permanent installation locks, pinned recovery software and private service recovery records remain. After an interrupted reply, inspect the result before continuing; ordinary removal and upgrades do not require a reboot.

  If a connection is lost, inspect the printed operation id with `puddle updates user@host --operation <id>`. To abandon a preparation before dispatch, add `--cancel` with that complete id. An accepted update cannot be cancelled or replayed. A `recovery_required` result remains visible for inspection; it is not reported as a successful installation.

  Status inspection also works when the daemon cannot connect: the CLI labels the result as recorded update state and reads it directly through your local or SSH access. This does not start the daemon or change the update. Cancellation and completion verification still require a live daemon connection; explicit continuation is described below. Launching a stopped modern host starts its selected service without reinstalling it. An explicit upgrade restores that coordinator before staging the requested release. Interrupted activation stays on the recovery path; it cannot be bypassed by launching or reinstalling.

  With a running daemon supporting application protocol 25.11+, use `puddle updates user@host --operation <id> --recover` to verify an installation which completed but lost its success reply. This checks that the updater and its commands have ended and verifies the selected software and runtime adoption. It never repeats installation or service commands. An incomplete installation, unavailable daemon or unconfirmed updater lifetime stays pending; this command does not restart a stopped daemon or roll back data.
  To explicitly continue a supported interrupted daemon update, use `puddle updates user@host --operation <id> --continue` (omit the host for local updates). This requires application protocol 25.12 on the live daemon, or on the verified staged daemon build when the daemon is unavailable. It dispatches an independent recovery worker only after checking the recorded update and prior worker lifetimes. Recorded acceptance or worker consumption does not mean the update completed: inspect the same operation again without `--continue` to see its result. A lost reply never causes automatic resubmission. Unsupported failure states remain pending; no old database is restored.

> [!NOTE]
> On Linux, `puddle install desktop` asks where to put `Puddle.AppImage`, defaulting to `~/puddle`. Update from inside the app and remove it by quitting and deleting the AppImage file. CLI desktop upgrade/removal is available only on macOS. Desktop releases cover macOS on Apple silicon and Linux x64.

`install` keeps an existing installation unless you name a version. `upgrade` selects the newest release or the named version; explicit daemon upgrades and macOS desktop upgrades also install a missing component. For example, `puddle upgrade cli@X.Y.Z` selects a published CLI version, including an older one. Keep CLI and daemon protocol versions compatible when pinning versions.

## Updating a host from a paired browser

Remote host updates require application protocol 26.0 and remote protocol 5.
Upgrade the target daemon/connector, cockpit and deployed service/application
through local/SSH access first. Existing per-profile browser approvals are kept,
but pairing alone never grants maintenance access.

In a local or SSH cockpit for that host, open **Settings → Remote & Sync →
Connected browsers**, expand the exact approved browser and choose **Allow host
maintenance**. Reconnect that browser. Only local/SSH access can grant or revoke
maintenance; a paired browser cannot grant it to itself or another device.

In the remote workspace, open **Host updates**, or choose **Review update** when
an available-release offer appears. Each new window can offer updates; idle
windows refresh host status every 60 seconds. Choose **Prepare daemon**,
**Prepare runtime software** or **Prepare both**, then **Review impact** and apply.
The review covers aggregate impact across every profile on this host. Stopping
daemon-owned work requires the separate **Interrupt listed work and apply** action.
Updating the runtime default never restarts existing agents or their shell jobs.
Session runtime inspection and restart remain available through local/SSH cockpits.

Keep the window connected until the host accepts the request. Revoking maintenance
blocks unaccepted work; an accepted update continues independently. After a lost
response or reconnect, inspect status before taking another action. Nothing is
automatically reapplied. **Verify completion** and **Continue recovery** are
explicit online actions. If the daemon or connector stays offline, use local/SSH
recovery; the remote browser cannot perform offline continuation.

## What are the CLI, daemon and desktop app?

- **CLI (`puddle`):** the frontend. It installs and manages Puddle components, opens the browser UI, and launches connections to local or SSH hosts.
- **Desktop app:** provides the same workspace UI in a native application window, with local and SSH connections. Component-management commands live in the CLI.
- **Daemon (`puddled`):** the backend. It runs on the host machine, communicates with the frontends, and manages session state and Git worktrees.
- **Runtime (`puddler`):** an independent owner for each runtime's agent and terminal processes. From 0.4.0, this is the standard backend. Independently supervised runtimes keep running across daemon upgrades; changing their runtime build requires a separate explicit restart.

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

3. Daemon and runtime install/upgrade commands resolve their own latest published version from the release manifest; UI-only releases need no host update. Failed release discovery leaves the host unchanged. Automatic bootstrap when opening a workspace uses the component versions pinned by the cockpit build. Naming `@version` requests exactly that component version; a skipped version is reported as unavailable. Upgrade the cockpit and host through the first manifest-aware release before relying on selective releases.
