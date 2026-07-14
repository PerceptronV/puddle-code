import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useClientSettings } from '../../lib/client-settings';
import { onThemeChange, xtermThemeFromCss } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { wsManager } from '../../lib/ws';
import { interceptImagePaste } from './paste-image';

export interface TerminalProps {
  /** PTY stream: a session uuid or `login-<accountId>`. */
  stream: string;
  term?: string;
  className?: string;
  onExit?: (code: number) => void;
}

/**
 * One xterm bound to one daemon PTY via the WS manager. The attach replay
 * repaints prior scrollback; the theme regenerates from the CSS variables on
 * every theme switch so terminal and chrome never drift apart (SPEC §12).
 */
export function Terminal({ stream, term = 'agent', className, onExit }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const settings = useClientSettings();
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const xterm = new XTerm({
      theme: xtermThemeFromCss(),
      fontFamily: "'Ubuntu Sans Mono', ui-monospace, monospace",
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      cursorBlink: true,
    });
    xtermRef.current = xterm;
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(container);
    fit.fit();

    const detach = wsManager.attach(stream, term, xterm.cols, xterm.rows, {
      onData: (data) => xterm.write(data),
      onExit: (code) => onExitRef.current?.(code),
    });
    const stdin = xterm.onData((data) => wsManager.write(stream, term, data));

    // Capture phase so this runs before xterm's own paste handler (which only
    // reads text/plain and would drop a clipboard image on the floor).
    const onPaste = (e: ClipboardEvent) => {
      if (interceptImagePaste(e, stream, term)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    container.addEventListener('paste', onPaste, true);

    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0) return; // hidden tab — keep the last size
      fit.fit();
      wsManager.resize(stream, term, xterm.cols, xterm.rows);
    });
    observer.observe(container);

    const unsubscribeTheme = onThemeChange(() => {
      xterm.options.theme = xtermThemeFromCss();
    });

    return () => {
      container.removeEventListener('paste', onPaste, true);
      observer.disconnect();
      unsubscribeTheme();
      stdin.dispose();
      detach();
      xterm.dispose();
      xtermRef.current = null;
    };
    // Deliberately keyed on the PTY identity only: recreating the terminal on
    // settings change would drop scrollback; the effect below patches the
    // live instance instead.
  }, [stream, term]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.fontSize = settings.terminalFontSize;
    xterm.options.scrollback = settings.terminalScrollback;
  }, [settings.terminalFontSize, settings.terminalScrollback]);

  return <div ref={containerRef} className={cn('size-full', className)} />;
}
