import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { Session, WsClientMessage, WsServerMessage } from '@puddle/shared';
import '../../src/styles/app.css';
import { Terminal } from '../../src/features/terminal/Terminal';
import { SessionContextMenu } from '../../src/features/workspace/sessions/SessionActions';
import { AppearanceSection } from '../../src/features/settings/sections/appearance';
import { Button } from '../../src/components/ui/button';
import { profile, sessions } from '../../src/dev/preview/data';
import { previewRequest } from '../../src/dev/preview/requests';
import {
  installBrowserTransport,
  type CockpitSocket,
} from '../../src/lib/transport/browser-transport';
import { tokenStore } from '../../src/lib/transport/auth';
import { profileStore } from '../../src/features/profile/profile-store';
import { applyTheme } from '../../src/lib/appearance/theme';
import { initClientSettings } from '../../src/lib/settings/client-settings';
import { setSessionRipple } from '../../src/features/terminal/ripple/preferences';
import type { FileLinkTarget } from '../../src/features/terminal/links/file-links';

const agent =
  ['codex', 'claude-code', 'gemini-cli', 'opencode'].find(
    (name) => name === new URLSearchParams(location.search).get('agent'),
  ) ?? 'codex';
const session: Session = { ...sessions[0]!, kind: 'agent', agent_type: agent, status: 'running' };
const sample = [
  '# A quieter place to work',
  '',
  'Ripple keeps the CLI close, with a little more room to read.',
  '',
  '## What changed',
  '',
  '- Prose uses the interface typeface.',
  '- Code keeps its alignment.',
  '- Keyboard editing and approvals stay in the native CLI.',
  '',
  '```ts',
  'const greeting = "Hello, Ripple";',
  'console.log(greeting);',
  '```',
  '',
  'A little mathematics: $E = mc^2$.',
  '',
  'flowchart LR',
  '  A[CLI buffer] --> B[Ripple]',
  '  B --> C[Read and copy]',
  '',
  'Read at your own pace. New output will wait while you scroll back or select text.',
  '',
  '› Ask Codex to do anything',
].join('\r\n');
// A full-screen agent writes frames into the alternate buffer, enables mouse
// reporting, and keeps its input/status rows in the same screen as the reply.
const alternateSample = (rows: number) =>
  '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2026h\x1b[2J\x1b[H' +
  [
    '\x1b[1m• Agent reply\x1b[0m',
    'This reply is drawn in the alternate screen.',
    'The formula is $E = mc^2$.',
    '',
    'flowchart LR',
    '  A[CLI] --> B[Ripple]',
    '',
  ].join('\r\n') +
  `\x1b[${rows - 3};1H› Ask Codex to do anything\r\n  Shift+Left still edits in the native CLI.\x1b[${rows - 3};3H\x1b[?2026l`;
const messages: WsClientMessage[] = [];
const openedFiles: FileLinkTarget[] = [];
const resolvedPaths: string[] = [];
let socket: FixtureSocket;
class FixtureSocket implements CockpitSocket {
  private events = new EventTarget();
  readyState: number = WebSocket.CONNECTING;
  constructor() {
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.events.dispatchEvent(new Event('open'));
      this.emit({ t: 'authenticated' });
    });
  }
  addEventListener<K extends 'open' | 'message' | 'close'>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
  ) {
    this.events.addEventListener(type, listener as EventListener);
  }
  emit(message: WsServerMessage) {
    this.events.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  send(raw: string) {
    const message = JSON.parse(raw) as WsClientMessage;
    messages.push(message);
    if (message.t === 'attach')
      queueMicrotask(() =>
        this.emit({
          t: 'replay',
          session: message.session,
          term: message.term,
          data: new URLSearchParams(location.search).has('live')
            ? ''
            : new URLSearchParams(location.search).has('alternate')
              ? alternateSample(message.rows)
              : sample,
        }),
      );
  }
  close() {
    this.readyState = WebSocket.CLOSED;
  }
}

installBrowserTransport({
  scope: 'ripple-preview',
  request: (method, path) => {
    const url = new URL(path, location.href);
    if (url.pathname.endsWith('/resolve')) {
      const target = url.searchParams.get('path') ?? '';
      resolvedPaths.push(target);
      const found =
        target === 'src/example.ts'
          ? { kind: 'file', path: target }
          : target === '/outside/notes.md'
            ? { kind: 'file', path: 'notes.md', root: '/outside' }
            : target === 'docs'
              ? { kind: 'dir', path: '/workspace/docs', relative_path: 'docs' }
              : null;
      return Promise.resolve(found ? Response.json(found) : new Response('', { status: 404 }));
    }
    return url.pathname === '/api/sessions'
      ? Promise.resolve(Response.json([session, sessions[1]!]))
      : previewRequest(method, path);
  },
  socket: () => {
    socket = new FixtureSocket();
    return socket;
  },
  input: async () => {},
});
tokenStore.set('sample-only');
profileStore.set(profile.id);
initClientSettings();
// An explicit demo URL enables only this sample session, never the global default.
if (new URLSearchParams(location.search).has('ripple')) setSessionRipple(session.id, true);

Object.assign(window, {
  rippleFixture: {
    messages,
    openedFiles,
    resolvedPaths,
    alternateScreen: () => {
      const size = messages.findLast((message) => message.t === 'attach' || message.t === 'resize');
      socket.emit({
        t: 'output',
        session: session.id,
        term: 'agent',
        data: alternateSample(size && 'rows' in size ? size.rows : 24),
      });
    },
    output: (data: string, replay = false) =>
      socket.emit({ t: replay ? 'replay' : 'output', session: session.id, term: 'agent', data }),
    theme: applyTheme,
    enable: (value: boolean | null) => setSessionRipple(session.id, value),
  },
});

function Fixture() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [shell, setShell] = useState(false);
  return (
    <div className="flex h-screen flex-col gap-3 bg-ground p-4">
      <header className="flex items-center gap-3">
        <SessionContextMenu session={session}>
          <button className="cursor-pointer text-sm">
            Sample agent · right-click for renderer
          </button>
        </SessionContextMenu>
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(!settingsOpen)}>
          Appearance
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setPaused(!paused)}>
          Pause viewer
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setShell(!shell)}>
          Switch shell
        </Button>
      </header>
      {settingsOpen && (
        <div className="max-h-72 overflow-auto">
          <AppearanceSection />
        </div>
      )}
      <main className="island-outline min-h-0 flex-1 overflow-hidden rounded-[var(--ui-radius)] p-3">
        <Terminal
          stream={shell ? sessions[1]!.id : session.id}
          paused={paused}
          parked={false}
          onOpenFile={(target) => openedFiles.push(target)}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <Fixture />
    </MemoryRouter>
  </QueryClientProvider>,
);
