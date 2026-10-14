# Notification delivery

Start the installed cockpit from an ordinary shell, outside any coding-agent session.

1. In Settings → Notifications, enable agent notifications and focused delivery.
   Use **Send test**. Check the visible result. On macOS, a rejected notification
   must show the native error; `UNErrorDomain` code 1 must also explain how to
   enable **Allow notifications** in System Settings → Notifications → Puddle,
   and mention app signing if Puddle is absent. Chromium permission must not
   claim OS authorisation. After enabling permission, send another test and
   confirm that success replaces the earlier error.
   A system-accepted result does not prove a banner is visible through Focus mode.
   Test the packaged app with both Developer ID and ad-hoc signing where available:
   `codesign --verify --deep --strict --verbose=2 /Applications/Puddle.app` must
   succeed, but this check alone does not verify notification approval or delivery.
   Check the actual permission prompt, banner and click for each signing mode,
   including after an app upgrade. Removing quarantine is not a permission grant.
2. Finish a managed agent turn while the cockpit is focused, then while unfocused.
   Both notify by default. Disable **Notify while interacting with a session**.
   Typing, pasting or clicking inside its main terminal suppresses its desktop
   alert for five seconds; another session still notifies. Leave it idle for
   five seconds, move to a file or another session, or leave the window: it
   notifies again. Merely opening a tab, focusing the window, hovering, scrolling
   and terminal output never extend suppression. Check sound and project mute
   independently. Click a notification to open its session.
3. In a terminal placement, launch a supported agent, perform a turn, and leave it
   idle. Initial prompts and idle redraws do not notify; a recognised busy-to-idle
   turn does. Exit the agent back to the shell: one completion notification.
   Suspend/background it: no false exit. The placement remains a blue terminal.
   Process polling can miss agents that start and exit between scans.
4. Finish and exit a managed agent. A clean exit not requested through Puddle
   notifies; Stop, Archive, Delete and daemon shutdown stay quiet.
5. With native Codex synchronisation, finish a turn and then clear/resume/fork.
   Completion follows the exact active conversation; tool/subagent threads do not
   notify on behalf of the main session.
6. In the mobile web workspace with browser permission granted, finish an agent
   turn while connected. Delivery uses a service worker, including on browsers
   that reject the Notification constructor. Click to select the relevant session.
   This live connection test does not establish background Web Push delivery.
7. In remote Settings enable background notifications and press **Send test**.
   Check the **Sending…** indicator and the result immediately below the button,
   including a failed request; it must not appear below the host/account controls.
   With permission and the device opt-in already enabled, check the subscription,
   host-registration and sending progress. A stalled worker registration or
   subscription read must report failure within ten seconds, restore the test
   button, and never send a test when that browser operation resolves late.
   A missing subscription must explain how to re-enable it; each explicit test
   must confirm host registration even when a previous test succeeded.
   At a narrow phone width and with larger text, expand Account security and
   Manage pairings: long account/host names and button labels must wrap without
   horizontal scrolling or clipped controls.
   Check the acknowledgement and the actual banner separately. On iOS/iPadOS,
   first install/open the Home Screen app. Complete a turn while focused, then
   background the app, then close it. Each produces a generic alert; a cold click
   reopens the correct host and requires normal authentication before content.
8. Revoke the browser on the host, mute the project, disable profile notifications,
   and disable remote access in separate trials: no new dispatches. A vendor may
   deliver already accepted messages within two minutes. Disable the device toggle
   and sign out: its PushManager subscription is removed.
9. Use an older daemon, connector or service: background enablement explains the
   missing capability. Live notification handling still works where supported.
   Simulate a 410 vendor response and verify the stale subscription is removed.

Automated coverage: native desktop delivery/failure/click/timeout; browser
service-worker delivery and errors; terminal completion versus suspension and
inspection failure; ordered Codex thread/turn signals; profile-scoped completion
and deliberate-stop suppression. OS banners and real mobile push permissions
remain manual checks.
