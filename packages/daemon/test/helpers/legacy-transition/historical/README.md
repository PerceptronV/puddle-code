# Historical first-upgrade acceptance

Run explicitly from the repository root:

```sh
PUDDLE_TEST_HISTORICAL_UPGRADE=1 node node_modules/vitest/vitest.mjs run packages/daemon/test/updates/continuity/historical-first-upgrade.test.ts
```

Ordinary tests skip this gate. It requires the retained Git object
`c33cdeef3a5df58badf73c3dd74cee8dca23bdbe` (`v0.3.14`), the matching installed
workspace dependencies and working native PTY/SQLite modules. It never fetches
history or packages. The historical and current lockfiles must both match the
pinned historical SHA-256; dependency upgrades require an explicit review of
how this historical build is reconstructed.

`source.ts` extracts the exact daemon/shared source and installer through
`git archive` into a temporary directory. Every historical shared alias resolves
there, and esbuild's input manifest rejects current daemon/shared source. The
temporary provenance record contains the commit, lock/source/bundle hashes,
application input list and host Node/platform identity. No historical bundle or
source snapshot is committed.

The gate starts the historical composition, protocol 25.6 and SQLite schema 28,
in a sanitised temporary home. Its only session is a real plain shell. The
current `ensureDaemon` and canonical installer must leave the old process and
shell state intact when approval is declined, then initialise the mandatory
runtime default and preserve the placement when approval is accepted. Both
automatic and explicit resume are exercised; a subsequent launcher connection
must produce neither another installation nor another runtime/resume event.

All service commands use an isolated executable fixture. `supervisor.ts` adds
the legacy bootstrap commands to the existing continuity supervisor. The user
home, service files, repository, archives, database and control sockets belong
to the fixture. No installed daemon, native service, real provider or user's
CLI conversation database is used. Cleanup stops verified fixture services;
uncertain cleanup retains the temporary home and executable files for inspection.

This proves a transition from **actual historical released source**, reconstructed
with the pinned dependency lock and host-native modules. It does not claim the
byte-identical published release archive, native systemd/launchd behaviour,
SSH transport, a desktop approval dialog or real provider conversation recovery.
The historical shell is expected to end on an approved first upgrade; persistent
process continuity starts with runtimes created by the new daemon.
