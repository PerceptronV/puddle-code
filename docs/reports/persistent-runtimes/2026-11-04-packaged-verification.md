# Isolated host archive and native upgrade verification

The final macOS arm64 host archive was built from production source
`159a348af1e24cb20f821d7a33d03cfdb4c165ac` on 4 November 2026. Pending
working-tree changes affected unrelated test helpers only. This records local
acceptance evidence; it does not certify a published or installed production upgrade.

| Item                       | Result                                                                            |
| -------------------------- | --------------------------------------------------------------------------------- |
| Archive                    | `puddled-v0.4.0-darwin-arm64.tar.gz`                                              |
| SHA-256                    | `c960b598744dc1ac110b1e2946b30c0dd1c7860313f27ee1ae94bf135555e7e4`                |
| Platform                   | macOS 26.5.2, arm64                                                               |
| Packaged Node              | 22.21.1                                                                           |
| Protocols                  | Application 26.1; remote 5; runtime 1.0                                           |
| Database schema            | 41                                                                                |
| Archive smoke              | Executable versions, capabilities, native dependencies and puddlang runner passed |
| Final packaged continuity  | 1 test passed in 23.93 seconds                                                    |
| Separate native continuity | 4 tests in 3 files passed in 187.22 seconds                                       |

The archive and adjacent checksum were retained as local build artefacts; they are
not checked into the repository or published. Build and run the packaged check
from the repository root with a fresh output directory:

```sh
archive_dir=$(mktemp -d /tmp/puddle-host-archive.XXXXXX)
node scripts/build-tarball.mjs --out-dir "$archive_dir"
PUDDLE_TEST_RUNTIME_RELEASE="$archive_dir/stage/puddled-v0.4.0" \
  PUDDLE_TEST_RUNTIME_ARCHIVE="$archive_dir/puddled-v0.4.0-darwin-arm64.tar.gz" \
  node node_modules/vitest/vitest.mjs run --project daemon \
  packages/daemon/test/runtime/lifecycle/release.test.ts --maxWorkers 1
```

The build bundles the host processes and management helpers directly from source.
The packaged test exercises the canonical installer, checksum receipt, immutable
same-version staging, pinned updater/runtime and native dependencies. Changing the
runtime default leaves the original owner and shell alive; controller replacement
preserves the shell PID and an in-memory variable. This test uses the existing
isolated scripted systemd manager, not native systemd. Its direct owner launch now
uses the existing fixture memory-admission helper; the initial run correctly refused
the outdated fixture's unreserved launch. No production admission guard was relaxed.

The separate native run used:

```sh
PUDDLE_TEST_RUNTIME_SUPERVISOR=1 node node_modules/vitest/vitest.mjs run \
  --project daemon \
  packages/daemon/test/updates/continuity/native-launchd.test.ts \
  packages/daemon/test/runtime/lifecycle/default-launch-live.test.ts \
  packages/daemon/test/runtime/lifecycle/supervisor-live.test.ts --maxWorkers 1
```

All four cases passed: ordinary and recovery launchd worker execution, default
runtime composition, and independent runtime/controller lifetime. Cleanup confirmed
removal of the exact fixture jobs and exit of their tracked processes and groups.
The fixtures use unique temporary homes and job labels with sanitised environments;
they never address installed daemon/connector labels or real provider accounts.

The native run began at `7d94fd538ee0d822d575fa6fb869017b68b55957`; the narrow
host-memory storage fix was committed while it ran. It is therefore transitional
source evidence, not proof that every native fixture bundle matches the final
archive. Both native transition release labels use current source, not historical
released binaries. The native worker journey begins at fixture-prepared approval
and dispatch because installed-label preflight is deliberately excluded. It
complements the full coordinator gates rather than replacing them.

Real-provider lifecycle, installed-label preflight, desktop approval, logout/reaper
behaviour and actual reboot acceptance remain separate. Native Linux verification
is deferred under the roadmap's explicit verification decision; these results do
not establish it.
