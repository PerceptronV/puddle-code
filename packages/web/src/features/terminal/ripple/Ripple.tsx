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
import { toastError } from '../../../lib/transport/errors';
import {
  createFileLinkCache,
  resolveFileLinkCandidate,
  type FileLinkTarget,
} from '../links/file-links';
import type { RippleAction } from './interactions';
import { rippleCellAtOffset, rippleOffsetAtPoint, relayRippleCell } from './source-map';
import { readRippleBuffer, type RippleSnapshot } from './buffer';
import { rippleHtml } from './markdown';
import { relayRippleWheel, rippleView } from './view';
import { RippleRichPart } from './RippleRichPart';
import { RippleBoundary } from './RippleBoundary';
import { useRippleBoundary, setRippleBoundary } from './preferences';
import { currentTheme, onThemeChange } from '../../../lib/appearance/theme';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import './ripple.css';
import { ripplePalette } from './xterm-style';
import { attachRippleTouchScroll } from './touch-scroll';
import { useRippleOverflow } from './use-overflow';

export function Ripple({
  terminal,
  stream,
  active,
  agentType,
  onOpenUri,
  onOpenFile,
}: {
  terminal: Terminal;
  stream: string;
  active: boolean;
  agentType?: string;
  onOpenUri(uri: string): void;
  onOpenFile?: (target: FileLinkTarget) => void;
}) {
  const [snapshot, setSnapshot] = useState<RippleSnapshot>(() => ({
    text: '',
    parts: [],
    truncated: false,
    alternate: terminal.buffer.active.type === 'alternate',
  }));
  const viewport = useRef<HTMLDivElement>(null);
  const [bottom, setBottom] = useState(80);
  const [nativeOffset, setNativeOffset] = useState(0);
  const [visibleRows, setVisibleRows] = useState(5);
  const [inputRows, setInputRows] = useState<number | null>(null);
  const nativeRows = useRippleBoundary(stream);
  const collapsed = nativeRows === 'cli';
  const fileCache = useMemo(() => createFileLinkCache(), [stream]);
  const updateView = useCallback(() => {
    const view = rippleView(terminal, agentType, nativeRows);
    setBottom(view.bottom);
    setNativeOffset(view.nativeOffset);
    setVisibleRows(view.nativeRows);
    setInputRows(view.inputRows);
    return view;
  }, [terminal, agentType, nativeRows]);
  useEffect(() => {
    // Upgrade a saved bottom anchor near the composer; distant manual divisions stay fixed.
    if (
      typeof nativeRows === 'number' &&
      nativeRows > 0 &&
      inputRows !== null &&
      Math.abs(nativeRows - inputRows) <= 3
    )
      setRippleBoundary(stream, nativeRows, inputRows);
  }, [stream, nativeRows, inputRows]);
  const readSnapshot = useCallback(
    (view = updateView()) => {
      const palette = ripplePalette(terminal, agentType);
      return readRippleBuffer(terminal.buffer.active, terminal.cols, view, palette.theme, palette);
    },
    [terminal, agentType, updateView],
  );
  useRippleOverflow(viewport, snapshot, active && !collapsed);
  const theme = useSyncExternalStore(onThemeChange, currentTheme, currentTheme);

  useLayoutEffect(() => {
    const native = terminal.element?.closest<HTMLElement>('.ripple-native');
    if (!native) return;
    const previous = native.style.transform;
    native.style.transform = collapsed || !nativeOffset ? '' : `translateY(${nativeOffset}px)`;
    return () => {
      native.style.transform = previous;
    };
  }, [terminal, nativeOffset, collapsed]);

  useEffect(() => {
    if (!active) return;
    if (collapsed) {
      updateView();
      const resize = terminal.onResize(updateView);
      return () => resize.dispose();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (force = false) => {
      clearTimeout(timer);
      timer = undefined;
      const view = updateView();
      const selection = window.getSelection();
      const selecting =
        selection && !selection.isCollapsed && viewport.current?.contains(selection.anchorNode);
      if (!force && selecting) return;
      const next = readSnapshot(view);
      setSnapshot((previous) =>
        previous.text === next.text &&
        previous.truncated === next.truncated &&
        previous.alternate === next.alternate &&
        previous.foreground === next.foreground &&
        previous.background === next.background &&
        JSON.stringify(previous.actions) === JSON.stringify(next.actions) &&
        JSON.stringify(previous.sourceMap) === JSON.stringify(next.sourceMap) &&
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
      terminal.onScroll(schedule),
      terminal.buffer.onBufferChange(() => {
        // Never retain the other buffer's content, even during selection.
        refresh(true);
      }),
    ];
    const nativeWheel = () => schedule();
    terminal.element?.addEventListener('wheel', nativeWheel, { capture: true, passive: true });
    document.addEventListener('selectionchange', schedule);
    refresh(true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      terminal.element?.removeEventListener('wheel', nativeWheel, true);
      subscriptions.forEach((subscription) => subscription.dispose());
    };
  }, [terminal, active, readSnapshot, updateView, collapsed]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !active || collapsed) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;
      // The CLI owns vertical scrolling; Ripple has no independent scroll range.
      event.preventDefault();
      relayRippleWheel(terminal, event);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    const detachTouch = attachRippleTouchScroll(element, terminal);
    return () => {
      element.removeEventListener('wheel', wheel);
      detachTouch();
    };
  }, [terminal, active, collapsed]);

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
                  {
                    styles: part.styles,
                    agentType,
                    background: snapshot.background,
                    anchorText: true,
                    topOfScreen:
                      part.offset !== undefined &&
                      snapshot.sourceMap?.rows.some(
                        (row) =>
                          row.row === snapshot.sourceMap?.viewport && row.start === part.offset,
                      ),
                  },
                ),
              ),
            }
          : null;
      }),
    [snapshot.parts, snapshot.background, snapshot.sourceMap, agentType],
  );

  const resolveFile = async (action: Extract<RippleAction, { kind: 'file' }>) => {
    for (const candidate of action.candidates) {
      const target = await resolveFileLinkCandidate(fileCache, stream, candidate);
      if (target) return target;
    }
    return null;
  };

  const pointer = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const nativeClick = (target: HTMLElement, point?: MouseEvent) => {
    if (!active || !snapshot.sourceMap) return;
    const root = target.closest<HTMLElement>('[data-ripple-part]');
    const part = root && snapshot.parts[Number(root.dataset.ripplePart)];
    if (!root || part?.kind !== 'text') return;
    const offset = point
      ? rippleOffsetAtPoint(root, part.source, point.clientX, point.clientY)
      : Number(target.querySelector<HTMLElement>('[data-ripple-start]')?.dataset.rippleStart);
    if (offset === null || !Number.isInteger(offset)) return;
    const cell = rippleCellAtOffset(snapshot.sourceMap, (part.offset ?? 0) + offset);
    if (cell) relayRippleCell(terminal, cell, point);
  };

  const activate = (target: HTMLElement, modified: boolean, keyboard = false) => {
    const element = target.closest<HTMLElement>('[data-ripple-action]');
    const action = element && snapshot.actions?.[Number(element.dataset.rippleAction)];
    if (action?.kind === 'url') onOpenUri(action.uri);
    else if (action?.kind === 'file') {
      if ((!modified && !keyboard) || !onOpenFile) return;
      void resolveFile(action)
        .then((resolved) => {
          if (resolved) onOpenFile(resolved);
        })
        .catch(toastError);
    } else {
      const href = target.closest('a')?.getAttribute('href');
      if (href && /^https?:\/\//i.test(href)) onOpenUri(href);
    }
  };

  return (
    <section
      className="ripple"
      style={{
        bottom: collapsed ? '100%' : bottom,
      }}
      data-alternate={snapshot.alternate}
      data-collapsed={collapsed}
      aria-label="Ripple reading view"
    >
      {!collapsed && (
        <div
          ref={viewport}
          className="ripple-scroll"
          style={{ color: snapshot.foreground, backgroundColor: snapshot.background }}
          tabIndex={0}
          aria-label="Readable terminal output"
          onPointerDown={(event) => {
            pointer.current = { x: event.clientX, y: event.clientY, dragged: false };
          }}
          onPointerMove={(event) => {
            if (
              event.buttons &&
              pointer.current &&
              Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 4
            )
              pointer.current.dragged = true;
          }}
          onKeyDown={(event) => {
            const target = event.target as HTMLElement;
            const summary = target.closest<HTMLElement>('[data-ripple-summary]');
            if (summary && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              nativeClick(summary);
              return;
            }
            if (target.closest('a,[data-ripple-action]')) {
              if (
                event.key === 'Enter' ||
                (event.key === ' ' && target.getAttribute('role') === 'button')
              ) {
                event.preventDefault();
                activate(target, event.metaKey || event.ctrlKey, true);
              }
              return;
            }
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) return;
            if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
              terminal.focus();
              terminal.input(event.key, true);
            } else if (
              [
                'Enter',
                'Escape',
                'Backspace',
                'Delete',
                'ArrowLeft',
                'ArrowRight',
                'ArrowUp',
                'ArrowDown',
                'PageUp',
                'PageDown',
                'Home',
                'End',
              ].includes(event.key)
            ) {
              event.preventDefault();
              terminal.focus();
              terminal.textarea?.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key: event.key,
                  code: event.code,
                  keyCode: event.keyCode,
                  shiftKey: event.shiftKey,
                  ctrlKey: event.ctrlKey,
                  altKey: event.altKey,
                  metaKey: event.metaKey,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            }
          }}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (!window.getSelection()?.isCollapsed || pointer.current?.dragged) return;
            if (target.closest('a,[data-ripple-action]')) {
              event.preventDefault();
              activate(target, event.metaKey || event.ctrlKey);
            } else nativeClick(target, event.nativeEvent);
          }}
          onMouseOver={(event) => {
            const element = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-ripple-action]',
            );
            const action = element && snapshot.actions?.[Number(element.dataset.rippleAction)];
            if (!element || action?.kind !== 'file' || !onOpenFile) return;
            void resolveFile(action).then((resolved) => {
              if (element.isConnected) {
                element.dataset.validFile = String(!!resolved);
                if (resolved) element.title = '⌘/Ctrl+click to open';
              }
            });
          }}
        >
          <div className="ripple-content">
            {snapshot.text ? (
              <div className="ripple-prose">
                {snapshot.parts.map((part, index) =>
                  part.kind === 'text' ? (
                    <div
                      key={index}
                      className="ripple-text"
                      data-ripple-part={index}
                      dangerouslySetInnerHTML={renderedParts[index]!}
                    />
                  ) : (
                    <RippleRichPart key={index} part={part} theme={theme} active={active} />
                  ),
                )}
              </div>
            ) : (
              <p className="ripple-note">
                Agent output will appear here. Type in the native input below.
              </p>
            )}
          </div>
        </div>
      )}
      <RippleBoundary
        terminal={terminal}
        stream={stream}
        rows={visibleRows}
        inputRows={inputRows}
      />
    </section>
  );
}
