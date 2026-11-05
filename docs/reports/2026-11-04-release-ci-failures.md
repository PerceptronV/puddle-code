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
tests passed all 21 checks. Another 58 checks across the remaining 17 changed
runtime fixture suites passed, for 79 runtime checks across 20 files. TypeScript,
lint and formatting passed for the fixes. Native Linux verification requires a
new CI run: local Docker is not running. These changes
do not turn the failed tagged jobs into passing jobs, move the tag, or publish
the release. Their Linux result must be recorded from the subsequent run.

## Follow-up, 5 November

The [0.4.1 release workflow](https://github.com/PerceptronV/puddle-code/actions/runs/41933219206)
and [0.4.2 release workflow](https://github.com/PerceptronV/puddle-code/actions/runs/41964083643)
passed, including the Linux packaged continuity checks. This confirms the corrected
container setup in those jobs; it does not establish native systemd acceptance.

General [0.4.2 CI](https://github.com/PerceptronV/puddle-code/actions/runs/41964082070)
still failed one encrypted-update fixture while 3,578 tests passed. Its timeout was
before upgrade dispatch, waiting for initial shell output. Inspection found that
the encrypted fixture awaited only the connector's `sent` acknowledgement before
sending terminal input. That acknowledges forwarding, while owner attachment and
canonical replay remain asynchronous. The local continuity viewer already awaits
replay; the encrypted fixture now also waits for a fresh replay matching the exact
session and terminal. A preceding attachment's replay cannot satisfy this wait.
Failure diagnostics now include bounded terminal output/error events so that a
future failure can distinguish attachment rejection from shell-command failure.
The corrected encrypted-update test passed locally in 36.68 seconds, including
replacement, preserved runtime/shell state and cleanup. Strict continuity-fixture
TypeScript, ESLint and formatting passed. Confirmation on the Linux CI runner
remains pending for this additional fixture fix.

## Browser acceptance follow-up

The [0.4.3 release workflow](https://github.com/PerceptronV/puddle-code/actions/runs/41981917242)
also passed. Subsequent general CI passed unit, process and SSH tests, including
the encrypted-update fixture, and reached browser acceptance.

Fresh browser profiles now open the installed release's notes. Unrelated remote,
pairing and settings tests did not close that modal, so it blocked their normal
navigation. A shared browser helper closes only the release-notes dialog through
its ordinary Close button, preserving real display and dismissal behaviour.
CI also runs the existing dedicated rendered release-notes acceptance script,
which verifies delayed section merging, version sequencing, persistent dismissal,
target scoping, Markdown safety and mobile presentation. That script and 15
affected remote/pairing/settings browser checks passed locally.

Proceeding beyond the modal exposed clipped five-character mobile project
abbreviations after the rail gained island padding. Collapsed labels now use the
existing monospace font; expanded names retain their existing font. The real
mobile browser fixture verifies that all five characters fit. Header assertions
also follow the current neutral action colour and inset divider spacing while
retaining alignment, selection and overflow checks.

The mobile journey then exposed delayed xterm selection notifications reopening
an empty action toolbar after Copy. Touch ownership now ends when the selected
range disappears, while a selected blank cell still offers Paste. Each terminal
mode in the browser fixture also waits for its own output marker before selecting,
and records a screenshot. The full real mobile flow passed locally, including
normal/mouse/alternate-screen selection, clipboard operations, Unicode input,
file previews and live viewer revocation. The notebook browser test now checks
the active cell's accessibility state instead of a removed outer background class;
its existing multi-cell clipboard and save assertions passed unchanged.

A serial browser run exposed a second release-note interaction: the lazy preview
and pairing dialog could commit together, causing both Radix dialogs to become
accessibility-hidden. Eight bounded traced reproductions failed. Pending notes
now observe other open dialogs and wait for them to close, retaining the same
queue and dismissal rules. All eight reproductions passed after this change.
Dedicated rendered acceptance also verifies deferred notes behind Settings,
preserved focus and subsequent version delivery.

The [first browser-fix CI run](https://github.com/PerceptronV/puddle-code/actions/runs/41984266954)
passed both Linux archives but timed out in one notebook kernel test, with 3,585
tests passing. The interrupt fixture treated the daemon's `busy` state as proof
that Python was executing its infinite-loop cell. That state includes dispatch,
so an idle kernel could receive SIGINT before the execution request. The fixture
now waits, with a ten-second bound, for a marker written inside that exact cell
before interrupting it. All four real-kernel lifecycle checks passed locally in
26.36 seconds. The CI timeout alone does not identify its precise blocked phase;
the subsequent Linux run remains the confirmation for this correction.

Local serial browser acceptance passed 93 tests in 4.7 minutes; the real-widget
case skipped because that process's PATH did not expose Jupyter. Running it with
the installed environment first exposed another readiness gap: Run All is visible
before the version query selects live execution, so the fixture could invoke its
legacy fallback. The widget case now waits for the live cell-run control to enable
before Run All. Its complete real-kernel flow passed in 36.3 seconds, including
binary uploads, extension callbacks and saved-state restoration. All 94 browser
cases have therefore passed locally across these two runs; Linux CI remains the
authoritative end-to-end release gate.

The [dialog-fix run](https://github.com/PerceptronV/puddle-code/actions/runs/41985717163)
passed every CI job, including browser, container and standalone packaging checks.
Two later Linux runs intermittently failed folding a section after reloading the
notebook input fixture. Six ordinary and two slower local pointer reproductions
passed, so the exact pointer failure remains unproven. Exercising that focus
journey with keyboard activation instead exposed a deterministic bug: the
notebook's Enter-to-edit shortcut intercepted Enter on toolbar buttons. Notebook
cell shortcuts now leave buttons alone. The input journey covers keyboard folding
and automatic input unfolding; the earlier editing journey retains mouse-fold
coverage. All four notebook browser tests passed locally after the fix. Failed
notebook cases retain traces, and CI uploads browser diagnostics for seven days.
