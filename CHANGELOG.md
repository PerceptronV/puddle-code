<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- `puddle start` and `puddle connect` now run the cockpit **in the background** once ready: the command bootstraps interactively (ssh prompts still land on your terminal), detaches, prints the URL, and exits — the terminal may close. `--foreground` keeps the old attached behaviour. New commands: `puddle list` shows running cockpits (verified by pid + a per-instance nonce the UI server echoes as `X-Puddle-Cockpit`, never by reachability alone) and `puddle kill [local | user@host | --all]` stops one — sessions keep running on the host. Cockpit records live in `~/.puddle/cockpits/`, background logs in `~/.puddle/logs/cockpit-<target>.log` (SPEC §10).

### Changed

- Releases no longer publish a `darwin-x64` daemon tarball: GitHub's last Intel Mac runner (`macos-13`) queues so long it blocked the whole release. Intel Mac hosts are unsupported until the entry is restored (or built under Rosetta); Apple-silicon Macs and Linux are unaffected.

### Fixed

- Proxied apps with absolute asset paths (any Vite/CRA-style build) no longer render a blank page through `/proxy/<sid>/<port>/`. Their `/assets/…` and `fetch('/api/…')` requests used to escape the proxy prefix and receive puddle's own `index.html` (the "Failed to load module script … MIME type of text/html" console error); the cockpit origin now 307-redirects any stray request whose `Referer` is a proxied page back under that page's prefix, and the static handler 404s missing assets instead of SPA-falling-back to HTML. WS handshakes and `no-referrer` apps still need the per-port `ssh -L` fallback (SPEC §9, §15.5 resolved).
- A request with a malformed percent-escape (e.g. `/100%_done.png`) no longer crashes the whole cockpit process: the static handler answers 404 instead of letting `decodeURIComponent` throw through the request listener.
- `puddle connect` no longer loops "tunnel lost — reconnecting… / tunnel restored". Three causes: the ssh forward ran with no keepalives, so idle NAT/firewall timeouts felled it on every quiet spell (`ServerAliveInterval=15`/`ServerAliveCountMax=3` on every ssh spawn now); a forward child killed after a failed readiness probe re-triggered the exit handler and spawned a second reconnect loop racing the first; and every sub-second blip printed a lost/restored pair (outages healing within a 2s grace window are now silent, unless the tunnel is genuinely flapping — a drop within 30s of a restore — which announces immediately). The forward also runs with `ExitOnForwardFailure=yes` so a failed `-L` bind dies visibly.
- `puddle start` can no longer be fooled by another cockpit's UI server sitting on the daemon's port. The UI server never auto-picks the daemon's own port (a `puddle connect` launched while 7433 was busy used to land exactly on 7434), and the daemon probe now verifies identity — only a 200 with this host's token counts; a 401/403 is reported as a clear port conflict instead of "token rejected" (or, worse, silently wiring the local cockpit to a remote daemon). A state directory without a managed install now bootstraps one rather than refusing (`start`/`connect` promise a running daemon — SPEC §10; the existing db/token/worktrees are untouched).
- The CLI build wipes `dist/` before bundling, so the published npm package can no longer pick up leftovers from earlier builds (v0.0.1 shipped three stray tsc artefacts from the pre-Phase-6 stub this way); the `bin` path is normalised to the form npm was auto-correcting at publish time. No protocol change.
