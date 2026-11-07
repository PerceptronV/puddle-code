import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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
import { relayRippleWheel, rippleView } from './view';
import { RippleRichPart } from './RippleRichPart';
import { RippleBoundary } from './RippleBoundary';
import { useRippleBoundary } from './preferences';
import { currentTheme, onThemeChange } from '../../../lib/appearance/theme';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import './ripple.css';
import { ripplePalette } from './xterm-style';

export function Ripple({
  terminal,
  stream,
  active,
  agentType,
  onDisable,
}: {
  terminal: Terminal;
  stream: string;
  active: boolean;
  agentType?: string;
  onDisable(): void;
}) {
  const [snapshot, setSnapshot] = useState<RippleSnapshot>(() =>
    readRippleBuffer(terminal.buffer.active, terminal.cols),
  );
  const viewport = useRef<HTMLDivElement>(null);
  const [bottom, setBottom] = useState(80);
  const [visibleRows, setVisibleRows] = useState(5);
  const nativeRows = useRippleBoundary(stream);
  const [showNative, setShowNative] = useState(false);
  const nativeScrollUntil = useRef(0);
  const scrollEdge = useRef<'start' | 'end' | null>(null);
  const readSnapshot = useCallback(() => {
    const view = rippleView(terminal, agentType, nativeRows);
    setBottom(view.bottom);
    setVisibleRows(view.nativeRows);
    const palette = ripplePalette(terminal);
    return readRippleBuffer(terminal.buffer.active, terminal.cols, view, palette.theme, palette);
  }, [terminal, agentType, nativeRows]);
  const follow = useRef(true);
  const scrollIntentUntil = useRef(0);
  const [following, setFollowing] = useState(true);
  const theme = useSyncExternalStore(onThemeChange, currentTheme, currentTheme);

  useEffect(() => {
    if (!active || showNative) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasAtBottom = terminal.buffer.active.viewportY === terminal.buffer.active.baseY;
    const refresh = (force = false) => {
      clearTimeout(timer);
      timer = undefined;
      const selection = window.getSelection();
      const selecting =
        selection && !selection.isCollapsed && viewport.current?.contains(selection.anchorNode);
      if (!force && (selecting || (!follow.current && Date.now() > nativeScrollUntil.current)))
        return;
      const next = readSnapshot();
      setSnapshot((previous) =>
        previous.text === next.text &&
        previous.truncated === next.truncated &&
        previous.alternate === next.alternate &&
        previous.foreground === next.foreground &&
        previous.background === next.background &&
        JSON.stringify(previous.parts) === JSON.stringify(next.parts)
          ? previous
          : next,
      );
    };
    const schedule = () => {
      // Throttle, not debounce: spinners cannot starve the reading view.
      timer ??= setTimeout(refresh, 32);
    };
    const subscriptions = [
      terminal.onWriteParsed(schedule),
      terminal.onResize(schedule),
      { dispose: onThemeChange(schedule) },
      terminal.onScroll(() => {
        const atBottom = terminal.buffer.active.viewportY === terminal.buffer.active.baseY;
        if (!atBottom || !wasAtBottom) nativeScrollUntil.current = Date.now() + 500;
        wasAtBottom = atBottom;
        schedule();
      }),
      terminal.buffer.onBufferChange(() => {
        follow.current = true;
        setFollowing(true);
        // Never retain the other buffer's content, even during selection.
        refresh(true);
      }),
    ];
    const nativeWheel = (event: WheelEvent) => {
      nativeScrollUntil.current = Date.now() + 500;
      scrollEdge.current = event.deltaY < 0 ? 'start' : 'end';
      schedule();
    };
    terminal.element?.addEventListener('wheel', nativeWheel, { capture: true, passive: true });
    document.addEventListener('selectionchange', schedule);
    refresh(true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      terminal.element?.removeEventListener('wheel', nativeWheel, true);
      subscriptions.forEach((subscription) => subscription.dispose());
    };
  }, [terminal, active, readSnapshot, showNative]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !active || showNative) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;
      const atEdge =
        event.deltaY < 0
          ? element.scrollTop <= 1
          : element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
      // Read the entire proportional projection first, then ask the CLI for
      // the preceding/next screen through its existing input path.
      if (atEdge) {
        event.preventDefault();
        relayRippleWheel(terminal, event);
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [terminal, active, showNative]);

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
                  { styles: part.styles, codex: agentType === 'codex' },
                ),
              ),
            }
          : null;
      }),
    [snapshot.parts, agentType],
  );
  useLayoutEffect(() => {
    const element = viewport.current;
    const content = element?.firstElementChild;
    if (!element || !content || !active || showNative) return;
    const settle = () => {
      if (scrollEdge.current) {
        element.scrollTop = scrollEdge.current === 'start' ? 0 : element.scrollHeight;
        scrollEdge.current = null;
      } else if (follow.current) element.scrollTop = element.scrollHeight;
    };
    const observer = new ResizeObserver(settle);
    observer.observe(content);
    settle();
    return () => observer.disconnect();
  }, [snapshot, active, showNative]);

  return (
    <section
      className="ripple"
      data-native={showNative}
      style={{
        bottom: showNative ? 'auto' : bottom,
        color: snapshot.foreground,
        backgroundColor: snapshot.background,
      }}
      data-alternate={snapshot.alternate}
      aria-label="Ripple reading view"
    >
      <div className="ripple-toolbar">
        <span className="flex items-center gap-2 text-sm">
          <Waves className="size-4" /> Ripple{' '}
          <span className="text-xs text-fg-muted">Experimental</span>
        </span>
        <ControlTray label="Ripple controls">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowNative(!showNative);
              terminal.focus();
            }}
          >
            {showNative ? 'Reading view' : 'Show CLI'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => terminal.focus()}>
            Type in CLI
          </Button>
          <Button variant="ghost" size="sm" onClick={onDisable}>
            <SquareTerminal /> CLI only
          </Button>
        </ControlTray>
      </div>
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
          if ((event.target as HTMLElement).closest('a')) return;
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) return;
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            terminal.focus();
            terminal.input(event.key, true);
          } else if (
            ['Enter', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight'].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            terminal.focus();
            terminal.textarea?.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: event.key,
                code: event.code,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
                bubbles: true,
                cancelable: true,
              }),
            );
          }
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
          if (!wasFollowing && follow.current) setSnapshot(readSnapshot());
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
          {snapshot.truncated && !snapshot.alternate && (
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
              Agent output will appear here. Type in the native input below; use Show CLI for menus
              and approvals.
            </p>
          )}
        </div>
      </div>
      {!following && (
        <Button
          className="ripple-latest"
          variant="secondary"
          size="sm"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            if (snapshot.alternate && agentType === 'codex') {
              const buffer = terminal.buffer.active;
              const controls = Array.from(
                { length: visibleRows + 1 },
                (_, index) =>
                  buffer
                    .getLine(buffer.viewportY + terminal.rows - index - 1)
                    ?.translateToString(true) ?? '',
              ).join('\n');
              if (/Back to bottom|Earlier messages available/.test(controls))
                terminal.input('\x1b', true);
            }
            terminal.scrollToBottom();
            setSnapshot(readSnapshot());
            if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
          }}
        >
          <ArrowDown />{' '}
          {snapshot.alternate && agentType !== 'codex' ? 'Bottom of view' : 'Latest output'}
        </Button>
      )}
      <RippleBoundary terminal={terminal} stream={stream} rows={visibleRows} />
    </section>
  );
}
