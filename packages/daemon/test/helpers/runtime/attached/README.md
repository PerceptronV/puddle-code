# Attached host-session lifetime acceptance

Run from the repository root:

```sh
node node_modules/vitest/vitest.mjs run packages/daemon/test/runtime/attached/lifetime.test.ts packages/daemon/test/runtime/lifecycle/lifetime.test.ts
```

The new gate composes actual `AttachedDaemon`, `SshTransport`, host authority,
installed runtime selection, detached dispatch, runtime owners and daemon
reconciliation. It reuses the packaged-continuity builder for native bundles and
release metadata. Each case has a temporary host home and sanitised shell environment;
no installed service, real provider or personal configuration is used.

Two fixture seams bound the evidence: the daemon's command runner reports an
unavailable user manager, and the SSH executable executes the normal channel
commands locally. The production installed-runtime composition is used; neither a
legacy runtime backend nor a forced supervisor kind is selected. A fixture reaper
kills only the exact tracked shell and owner after attached daemon closure.

The cases prove:

- On this permissive process lifetime, closing the attached daemon leaves its owner
  and shell alive. Reconnection adopts the same owner, shell PID, generation,
  variable and cwd.
- If an external policy reaps that owner and shell, automatic resume creates one
  replacement. With auto-resume disabled the placement remains interrupted until
  explicit resume. Neither outcome restores in-memory shell state.
- Input whose side effect is observed only through a fixture file, with its
  remainder still blocked in `read`, is not replayed by reconnect or resume.
- A second healthy connection does not create a competing owner. Cleanup verifies
  process identity; uncertainty retains the fixture and bundle paths.

These are process/channel tests, not native OpenSSH, PAM, logout, reboot or cgroup
acceptance. They do not prove permanent detached persistence or enable host updates
without a service manager. Native loopback SSH authority has separate coverage in
`packages/cli/ssh-test/control.test.ts`; that fixture uses `UsePAM no` and also cannot
prove login-manager teardown policy. No separate runtime-holding channel is added.
