# Notification delivery

Start the installed cockpit from an ordinary shell, outside any coding-agent session.

1. In Settings → Notifications, enable agent notifications and focused delivery.
   Use **Send test**. Check the visible result. On macOS, a rejected notification
   must show the native error; Chromium permission must not claim OS authorisation.
   A system-accepted result does not prove a banner is visible through Focus mode.
2. Finish a managed agent turn while the cockpit is focused, then while unfocused.
   Both notify by default. Select background-only delivery and repeat. Check sound
   and project mute independently. Click a notification to open its session.
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

Automated coverage: native desktop delivery/failure/click/timeout; browser
service-worker delivery and errors; terminal completion versus suspension and
inspection failure; ordered Codex thread/turn signals; profile-scoped completion
and deliberate-stop suppression. OS banners and real mobile push permissions
remain manual checks.
