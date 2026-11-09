# Huddle crash recovery

A huddle's independent owner survives frontend closure and daemon replacement.
When the owner itself crashes, recovery creates one new owner from its captured
revision, committed ledger, queues and trigger cursors. Completed nodes are not
replayed. In-flight scripts become interrupted; their external effects can remain
unknown. Recovery never resumes arbitrary JavaScript at its previous await.

**Recover after crash** uses the exact recorded owner. Supporting runtimes can also
recover armed huddles through the existing owner-loss reconciler, with a retained
limit of three automatic replacements. Stop, archive, inactive intent and host
maintenance continue to prevent automatic recovery. Lost replies require inspection,
not another recovery command. **Recover after reboot** remains a separate action;
reboot auto-start is separately opt-in.

Same-boot recovery requires positive kernel evidence that the old owner's script
scope has ended, in addition to the normal launch/owner/state/revision claims:

- Linux systemd/cgroup-v2: the recorded cgroup must be empty or removed, with the
  same boot, mount, namespace and identity.
- macOS launchd, application 28.24 and runtime `coalitionRecovery: 1`: the owner
  captures its resource coalition before project code starts. A small pinned native
  probe reads kernel membership/counters. An active detached descendant blocks
  recovery even after the owner and ordinary workers have died. Once counters show
  an empty scope, normal service retirement rechecks that evidence under the owner
  and dispatch claims, unregisters the exact service, then waits for the kernel to
  report the coalition reaped. Only that final proof permits replacement.

The macOS probe is read-only and never signals a PID. It verifies that capture is
performed by a child of the current same-user launchd owner, rather than accepting
a process-group id or an arbitrary recorded PID. It uses optional Darwin interfaces;
missing helpers, unsupported interfaces or unavailable evidence leave the owner
eligible only for verified reboot recovery. Native helper failures never fall back
to PID disappearance as proof. Release archives compile the helper on their target
macOS host; installed users need no compiler.

This follows XNU's coalition membership, monotonically assigned ids and removal
rules: a reaped coalition has no active members and cannot admit new ones. The
private record binds that id to the original runtime identity and boot. See Apple's
[coalition implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/coalition.c),
[read-only syscall](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_coalition.c)
and [process-info interface](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h).

Detached host-session lifetimes have no comparable independent containment proof
here. They retain their explicit limited lifetime and reboot-only recovery. Likewise,
a surviving detached child on macOS can block recovery until it exits; the recovery
command does not kill arbitrary descendants. External services and agent owners
are separate resources: an empty script scope says nothing about whether a remote
request completed. Their existing operation receipts and reconciliation still apply.
Trusted project code is not sandboxed against deliberately moving work into another
service or changing private host records.

Crash recovery copies a committed SQLite snapshot, including retained WAL contents,
without modifying the original ledger. Before opening that private copy in memory,
it changes the serialized journal-mode header as required by
[SQLite deserialize](https://www.sqlite.org/c3ref/deserialize.html). The replacement
verifies the seed digest and fencing evidence before starting its scheduler.

Native acceptance on macOS 26.5.2 arm64 covers a real launchd huddle killed while a
detached descendant survives: recovery refuses while that child runs, then retires
the service, resumes queued work once, interrupts the in-flight script and refuses
a second replacement of the original owner. Broader macOS versions/architectures,
real-provider operation continuity, reboot and packaged-upgrade acceptance remain
separate checks in [huddle acceptance](../acceptance/huddle.md).
