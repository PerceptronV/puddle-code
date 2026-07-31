import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ProjectDetail, Session } from '@puddle/shared';
import { desktopBridge } from '../../lib/desktop';
import { notificationPermission } from '../../lib/notification-permission';
import { fetchAllSessions, hostLabel, useHostInfo, useProfileSettings } from '../../lib/queries';
import { wsManager } from '../../lib/ws';
import { useCurrentProfileId } from '../profile/profile-store';

/** The profile's notification prefs (SPEC §11); delivery defaults mirror the settings tab. */
interface NotificationPrefs {
  desktop: boolean;
  sound: boolean;
  muted_projects: string[];
}
const DEFAULT_PREFS: NotificationPrefs = { desktop: true, sound: false, muted_projects: [] };

/**
 * Whether a waiting_input transition should raise a desktop notification /
 * sound. Pure, so the policy is testable: muted projects are silent, the
 * desktop notification additionally needs granted permission and an
 * UNFOCUSED window (a focused one already shows the green waiting pulse —
 * an OS banner over it would be noise).
 */
export function decideNotification(args: {
  prefs: NotificationPrefs;
  projectId: string;
  windowFocused: boolean;
  permission: NotificationPermission | 'unsupported';
}): { desktop: boolean; sound: boolean } {
  if (args.prefs.muted_projects.includes(args.projectId)) return { desktop: false, sound: false };
  return {
    desktop: args.prefs.desktop && args.permission === 'granted' && !args.windowFocused,
    sound: args.prefs.sound,
  };
}

/** Find a session across every cached list (same sweep as useStatusCacheSync). */
function findSession(qc: QueryClient, id: string): Session | undefined {
  for (const [, data] of qc.getQueriesData<Session[]>({ queryKey: ['sessions'] })) {
    const hit = data?.find((s) => s.id === id);
    if (hit) return hit;
  }
  for (const [, data] of qc.getQueriesData<ProjectDetail>({ queryKey: ['project'] })) {
    const hit = data?.sessions.find((s) => s.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function displayTitle(session: Session): string {
  return session.title ?? session.agent_title ?? session.osc_title ?? session.id.slice(0, 8);
}

/** A short two-tone ping via WebAudio — no asset, respects nothing but volume. */
function playPing(): void {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0.04;
    gain.connect(ctx.destination);
    for (const [freq, at] of [
      [880, 0],
      [1318.5, 0.09],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.12);
    }
    setTimeout(() => void ctx.close(), 400);
  } catch {
    // No audio context (autoplay policy, headless) — the badge still shows.
  }
}

/**
 * waiting_input delivery (SPEC §11, task of the Notifications settings tab):
 * on a session's live transition to waiting_input — the WS status feed only
 * carries real transitions — raise a desktop notification (clicking focuses
 * the session), play the optional sound, and keep a "(n)" badge of currently
 * waiting agent sessions in the document title. Mounted once in the shell.
 */
export function useWaitingNotifications(): void {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const prefsRef = useRef<NotificationPrefs>(DEFAULT_PREFS);
  prefsRef.current = {
    ...DEFAULT_PREFS,
    ...((settings.data?.['notifications'] as Partial<NotificationPrefs> | undefined) ?? {}),
  };

  // The title's base is the machine's label (display-name customisation
  // first, then hostname) — same base the workspace title builds on. A ref,
  // so a late-loaded label doesn't tear down the WS subscription (that would
  // drop the waiting set).
  const host = useHostInfo();
  const baseTitle = hostLabel(host.data) ?? 'puddle';
  const baseRef = useRef(baseTitle);
  useEffect(() => {
    // Adopt a late-loaded (or renamed) host label only when the title still
    // shows the stale base — never stomp a workspace's "project — host".
    if (document.title === baseRef.current) document.title = baseTitle;
    baseRef.current = baseTitle;
  }, [baseTitle]);

  useEffect(() => {
    const waiting = new Set<string>();
    const updateBadge = () => {
      document.title = waiting.size > 0 ? `(${waiting.size}) ${baseRef.current}` : baseRef.current;
    };

    const off = wsManager.onStatus((event) => {
      const wasWaiting = waiting.has(event.session);
      if (event.status === 'waiting_input') waiting.add(event.session);
      else waiting.delete(event.session);
      updateBadge();
      if (event.status !== 'waiting_input' || wasWaiting) return;

      void (async () => {
        // A tab parked on the dashboard (or one whose caches were collected
        // after idling) may not hold the session anywhere — fetch the list
        // rather than silently dropping the notification.
        let session = findSession(qc, event.session);
        if (!session) {
          try {
            session = (await fetchAllSessions(qc)).find((s) => s.id === event.session);
          } catch {
            return; // connection lost mid-transition; nothing sane to show
          }
        }
        if (!session || session.kind === 'terminal') return; // shells never "wait for input"
        const found = session;
        const verdict = decideNotification({
          prefs: prefsRef.current,
          projectId: found.project_id,
          windowFocused: document.hasFocus(),
          permission: notificationPermission(),
        });
        if (verdict.sound) playPing();
        if (verdict.desktop) {
          const n = new Notification(displayTitle(found), {
            body: 'Waiting for your input',
            tag: `puddle-waiting-${found.id}`, // replaces, never stacks per session
          });
          n.onclick = () => {
            // window.focus() raises a browser tab; only the desktop shell's
            // main process can raise an OS window.
            desktopBridge()?.raiseWindow();
            window.focus();
            void navigate(`/project/${found.project_id}/session/${found.id}`);
            n.close();
          };
        }
      })();
    });
    return () => {
      off();
      document.title = baseRef.current;
    };
  }, [qc, navigate]);
}
