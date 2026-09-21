# Phase 5 acceptance — forwarded applications

Protocol 18.0 replaces the original same-origin/master-cookie proxy flow.
Follow [connection authority acceptance](connection-authority.md#forwarded-applications)
for the current manual procedure: trusted cockpit landing links, isolated
`127.0.0.1` application content, target-scoped HttpOnly cookies, preserved
application authentication and HTTP/WebSockets, detected-port restrictions,
path recovery and credential stripping.

Use a plain shell and disposable home, as described in that document. Test
both a local app's direct localhost link and an SSH app's proxy link; verify
the port strip stays in its own terminal pane, updates automatically and
still offers a copyable `ssh -L` command. Absolute WebSocket URLs and apps
that suppress Referer may require their explicit proxy prefix or that tunnel.

The automated process suite `packages/cli/e2e/proxy.test.ts` exercises real
HTTP, WebSockets and a stream spanning token rotation. It does not replace
manual checks of browser origin isolation, cookie attributes or HMR rendering.
