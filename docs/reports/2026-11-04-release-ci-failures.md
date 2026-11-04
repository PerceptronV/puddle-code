# 0.4.0 release and CI failures

The first tagged 0.4.0 run exposed failures that the preceding local macOS checks
did not establish as passing on Linux. The [release run](https://github.com/PerceptronV/puddle-code/actions/runs/41928078878)
failed packaged runtime continuity on both Linux architectures; the
[CI run](https://github.com/PerceptronV/puddle-code/actions/runs/41928077485) failed
three tests, with 3,567 passing and 25 skipped. The earlier local acceptance record
is not evidence of a passing release pipeline.

## Packaged Linux process lifetime

The scripted manager launches an independent updater and exits, leaving that
process to the container's orphan reaper. Both release logs show that its PID
remained observable after cleanup's twenty-second stop deadline. The Rocky jobs
had no init process configured. Unreaped zombies are the leading explanation,
consistent with the preceding thirty-second group-absence wait, but the original
failure was masked by cleanup and the logs do not prove the process state.

Both Linux workflows now use Docker `--init`, explicitly install `procps-ng` for
the updater's `/bin/ps` inspection, and run an isolated preflight that checks
process inspection and actual orphan-group disappearance. It gates the orphan's
exit until its parent has exited; it requires `ESRCH`, not merely zombie state.
The packaged continuity test now also runs in ordinary Linux archive CI, which
previously checked only archive smoke tests and ABI compatibility. The fixture
retains both original and cleanup failures. Production lifetime checks are unchanged.

## Controller handoffs and notebook environment

Two runtime fixtures acquired a controller synchronously while an existing owner
was writing the shared memory ledger. Normal daemon startup already uses bounded
asynchronous acquisition; the affected live-owner fixtures now use that path too.
No SQLite timeout, memory limit or production admission rule is relaxed.

The notebook fixture created a second venv using `--system-site-packages`. That
inherits the base interpreter's packages, not packages installed into CI's invoking
Jupyter venv. A test-only helper now exposes the invoking environment's exact
package directories through a `.pth` file while preserving a separate selected
prefix. A regression checks a module available only in the source venv.

## Verification scope

The orphan-reaping preflight passed locally on macOS, and the packaged continuity
test passed in 20.84 seconds against the retained 0.4.0 macOS archive. All five
focused notebook checks passed, including real kernel execution and a source-venv
package regression. The two failing runtime suites and exclusive-lock controller
tests passed all 21 checks. TypeScript, lint and formatting passed for the fixes.
Native Linux
verification requires a new CI run: local Docker is not running. These changes
do not turn the failed tagged jobs into passing jobs, move the tag, or publish
the release. Their Linux result must be recorded from the subsequent run.
