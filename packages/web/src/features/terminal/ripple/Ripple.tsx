import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import { ArrowDown, SquareTerminal, Waves } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { ControlTray } from '../../../components/ui/control-tray';
import { openBrowserLink } from '../../ports/forward-link';
import { toastError } from '../../../lib/transport/errors';
import { sshMode } from '../../../lib/transport/ssh-mode';
import { rewriteTerminalUri } from '../links/proxy-links';
import { readRippleBuffer, type RippleSnapshot } from './buffer';
import { rippleHtml } from './markdown';
import { RippleRichPart } from './RippleRichPart';
import { currentTheme, onThemeChange } from '../../../lib/appearance/theme';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import './ripple.css';

export function Ripple({
  terminal,
  stream,
  active,
  onDisable,
}: {
  terminal: Terminal;
  stream: string;
  active: boolean;
  onDisable(): void;
}) {
  const [snapshot, setSnapshot] = useState<RippleSnapshot>(() =>
    readRippleBuffer(terminal.buffer.active, terminal.cols),
  );
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const scrollIntentUntil = useRef(0);
  const [following, setFollowing] = useState(true);
  const theme = useSyncExternalStore(onThemeChange, currentTheme, currentTheme);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = undefined;
      const selection = window.getSelection();
      const selecting =
        selection && !selection.isCollapsed && viewport.current?.contains(selection.anchorNode);
      if (terminal.buffer.active.type === 'normal' && (!follow.current || selecting)) return;
      const next = readRippleBuffer(terminal.buffer.active, terminal.cols);
      setSnapshot((previous) =>
        previous.text === next.text &&
        previous.truncated === next.truncated &&
        previous.alternate === next.alternate
          ? previous
          : next,
      );
    };
    const schedule = () => {
      // Throttle, not debounce: spinners cannot starve the reading view.
      timer ??= setTimeout(refresh, 120);
    };
    const subscriptions = [
      terminal.onWriteParsed(schedule),
      terminal.onResize(schedule),
      terminal.buffer.onBufferChange(() => {
        follow.current = true;
        setFollowing(true);
        refresh();
      }),
    ];
    document.addEventListener('selectionchange', schedule);
    refresh();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      subscriptions.forEach((subscription) => subscription.dispose());
    };
  }, [terminal, active]);

  const renderedParts = useMemo(
    () =>
      snapshot.parts.map((part, index) => {
        const previous = snapshot.parts[index - 1];
        const next = snapshot.parts[index + 1];
        return part.kind === 'text'
          ? {
              __html: DOMPurify.sanitize(
                rippleHtml(
                  part.source,
                  previous?.kind === 'math' && !previous.display,
                  next?.kind === 'math' && !next.display,
                ),
              ),
            }
          : null;
      }),
    [snapshot.parts],
  );
  useLayoutEffect(() => {
    const element = viewport.current;
    const content = element?.firstElementChild;
    if (!element || !content || !active) return;
    const settle = () => {
      if (follow.current) element.scrollTop = element.scrollHeight;
    };
    const observer = new ResizeObserver(settle);
    observer.observe(content);
    settle();
    return () => observer.disconnect();
  }, [snapshot, active]);

  return (
    <section
      className="ripple"
      data-alternate={snapshot.alternate}
      aria-label="Ripple reading view"
    >
      <div className="ripple-toolbar">
        <span className="flex items-center gap-2 text-sm">
          <Waves className="size-4" /> Ripple{' '}
          <span className="text-xs text-fg-muted">Experimental</span>
        </span>
        <ControlTray label="Ripple controls">
          <Button variant="ghost" size="sm" onClick={() => terminal.focus()}>
            Type in CLI
          </Button>
          <Button variant="ghost" size="sm" onClick={onDisable}>
            <SquareTerminal /> CLI only
          </Button>
        </ControlTray>
      </div>
      {snapshot.alternate ? (
        <p className="px-4 pb-3 text-xs text-fg-muted">
          This full-screen CLI needs the native terminal.
        </p>
      ) : (
        <div
          ref={viewport}
          className="ripple-scroll"
          tabIndex={0}
          aria-label="Readable terminal output"
          onWheel={() => {
            scrollIntentUntil.current = Date.now() + 1000;
          }}
          onPointerDown={() => {
            scrollIntentUntil.current = Date.now() + 1000;
          }}
          onPointerMove={(event) => {
            if (event.buttons) scrollIntentUntil.current = Date.now() + 1000;
          }}
          onKeyDown={(event) => {
            if (
              ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
            )
              scrollIntentUntil.current = Date.now() + 1000;
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            const wasFollowing = follow.current;
            const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
            // Async diagram sizing and browser clamping also emit scroll events;
            // only a reader gesture can turn automatic following off.
            if (atBottom || Date.now() < scrollIntentUntil.current) follow.current = atBottom;
            setFollowing(follow.current);
            if (!wasFollowing && follow.current)
              setSnapshot(readRippleBuffer(terminal.buffer.active, terminal.cols));
          }}
          onClick={(event) => {
            const link = (event.target as HTMLElement).closest('a');
            if (!link) return;
            event.preventDefault();
            const href = link.getAttribute('href');
            if (href && /^https?:\/\//i.test(href))
              void openBrowserLink(rewriteTerminalUri(href, stream, sshMode() !== null)).catch(
                toastError,
              );
          }}
        >
          <div className="ripple-content">
            {snapshot.truncated && (
              <p className="ripple-note">Recent output · Full history is available in the CLI.</p>
            )}
            {snapshot.text ? (
              <div className="ripple-prose">
                {snapshot.parts.map((part, index) =>
                  part.kind === 'text' ? (
                    <div
                      key={index}
                      className="ripple-text"
                      dangerouslySetInnerHTML={renderedParts[index]!}
                    />
                  ) : (
                    <RippleRichPart key={index} part={part} theme={theme} active={active} />
                  ),
                )}
              </div>
            ) : (
              <p className="ripple-note">
                Agent output will appear here. Type and approve requests in the CLI below.
              </p>
            )}
          </div>
        </div>
      )}
      {!snapshot.alternate && !following && (
        <Button
          className="ripple-latest"
          variant="secondary"
          size="sm"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            setSnapshot(readRippleBuffer(terminal.buffer.active, terminal.cols));
            if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
          }}
        >
          <ArrowDown /> Latest output
        </Button>
      )}
    </section>
  );
}
