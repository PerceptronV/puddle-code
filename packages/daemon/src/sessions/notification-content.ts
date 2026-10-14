import type { AgentNotification, NotificationContent, Session } from '@puddle/shared';
import type { SessionServiceDeps } from './service.js';
import type { StatusPatterns } from '../agents/adapter.js';
import { stripAnsi } from '../pty/ansi.js';

export function notificationSnippet(text: string, patterns?: StatusPatterns): string {
  const ignored = patterns
    ? [...patterns.waitingInput, ...(patterns.busy ?? []), ...(patterns.limitReached ?? [])]
    : [];
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^[\s─━═\-_=│┌┐└┘╭╮╰╯›❯>$]+$/u.test(line) &&
        !ignored.some((pattern) =>
          new RegExp(pattern.source, pattern.flags.replace('g', '')).test(line),
        ),
    );
  const compact = lines
    .join(' ')
    // eslint-disable-next-line no-control-regex -- OS banners must not retain terminal controls.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > 256 ? `${compact.slice(0, 255).trimEnd()}…` : compact;
}

export async function notificationContent(
  session: Session,
  reason: AgentNotification['reason'],
  deps: SessionServiceDeps,
): Promise<NotificationContent> {
  // Capture before yielding: exit releases the screen and native rebinding moves it.
  const screen = deps.ptys.notificationOutput(session.id).catch(() => '');
  const adapter = session.agent_type ? deps.adapters.get(session.agent_type) : undefined;
  let reply: string | null = null;
  if (adapter?.notificationOutput && session.account_id && session.agent_session_ref) {
    reply = await adapter
      .notificationOutput(session.agent_session_ref, deps.accounts.get(session.account_id))
      .catch(() => null);
  }
  const body = reply
    ? notificationSnippet(reply)
    : notificationSnippet((await screen).split('\n').slice(-8).join('\n'), adapter?.statusPatterns);
  return {
    title:
      notificationSnippet(
        session.title ?? session.agent_title ?? session.osc_title ?? session.id.slice(0, 8),
      ).slice(0, 160) || 'Puddle',
    body: body || (reason === 'exited' ? 'Agent finished running' : 'Waiting for your input'),
    project: session.project_id,
    session: session.id,
  };
}
