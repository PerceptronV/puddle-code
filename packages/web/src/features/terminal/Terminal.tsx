import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { tokenStore } from '../../lib/auth';
import { useClientSettings } from '../../lib/client-settings';
import { sshMode } from '../../lib/ssh-mode';
import { cssTokenReader, onThemeChange, xtermThemeFromCss } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { wsManager } from '../../lib/ws';
import { dynamicColourReport, type DynamicColourCode } from './osc-colour';
import { interceptImagePaste } from './paste-image';
import { rewriteTerminalUri } from './proxy-links';
import { registerFileLinks } from './file-links';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * macOS line-editing shortcuts the browser would otherwise eat: ⌘←/⌘→ move to
 * line start/end and ⌘⌫/⌘⌦ delete to line start/end, translated to the readline
 * control codes the PTY expects. ⌘←/⌘→ are also the browser's history
 * back/forward, so we must preventDefault. Keyed by `e.key` (layout-independent).
 */
const MAC_LINE_EDITS: Record<string, string> = {
  ArrowLeft: '\x01', // ⌘← → Ctrl-A: start of line
  ArrowRight: '\x05', // ⌘→ → Ctrl-E: end of line
  Backspace: '\x15', // ⌘⌫ → Ctrl-U: delete to start of line
  Delete: '\x0b', // ⌘⌦ → Ctrl-K: delete to end of line
};

export interface TerminalProps {
  /** PTY stream: a session uuid or `login-<accountId>`. */
  stream: string;
  term?: string;
  className?: string;
  onExit?: (code: number) => void;
  /** Cmd/Ctrl+click on a validated file path opens it in the editor (SPEC §7). */
  onOpenFile?: (path: string, line?: number, column?: number) => void;
}

/**
 * One xterm bound to one daemon PTY via the WS manager. The attach replay
 * repaints prior scrollback; the theme regenerates from the CSS variables on
 * every theme switch so terminal and chrome never drift apart (SPEC §12).
 */
export function Terminal({ stream, term = 'agent', className, onExit, onOpenFile }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const settings = useClientSettings();
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

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
    // URL links are safe everywhere (login terminals included): plain click or
    // cmd/ctrl+click both open the URL in a new tab (SPEC §7). In SSH mode a
    // host-localhost URL is rewritten to the tier-2 proxy path so it works
    // from the client; login terminals have no session to proxy through.
    xterm.loadAddon(
      new WebLinksAddon((_event, uri) => {
        const target = stream.startsWith('login-')
          ? uri
          : rewriteTerminalUri(uri, stream, sshMode() !== null, tokenStore.get());
        window.open(target, '_blank', 'noopener,noreferrer');
      }),
    );
    xterm.open(container);
    fit.fit();

    // Validated file-path links: only for real sessions (login PTYs have no
    // worktree to resolve against) and only when a handler is wired.
    const fileLinks =
      onOpenFileRef.current && !stream.startsWith('login-')
        ? registerFileLinks(xterm, stream, (path, line, column) =>
            onOpenFileRef.current?.(path, line, column),
          )
        : null;

    const detach = wsManager.attach(stream, term, xterm.cols, xterm.rows, {
      onData: (data) => xterm.write(data),
      onExit: (code) => onExitRef.current?.(code),
    });
    const stdin = xterm.onData((data) => wsManager.write(stream, term, data));

    // Answer the terminal dynamic-colour queries (OSC 10 foreground, OSC 11
    // background) that xterm.js leaves unanswered. An agent with auto/system
    // theme detection (e.g. Claude Code) queries the background luminance to
    // choose light vs dark; without a reply it cannot match the puddle theme.
    // Tokens are read live so the answer reflects the theme at query time.
    const answerColour = (code: DynamicColourCode, token: string) => (data: string) => {
      if (data !== '?') return false; // a set request, not a query — leave it to xterm
      const report = dynamicColourReport(code, cssTokenReader()(token));
      if (report) wsManager.write(stream, term, report);
      return true;
    };
    const oscForeground = xterm.parser.registerOscHandler(10, answerColour(10, '--text-primary'));
    const oscBackground = xterm.parser.registerOscHandler(11, answerColour(11, '--bg-base'));

    if (IS_MAC) {
      xterm.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return true;
        // ⌘C copies the selection to the clipboard — xterm has no built-in copy,
        // and Ctrl-C stays the interrupt. With nothing selected it falls through,
        // so ⌘C then does nothing. ⌘V needs no handling: xterm already pastes on
        // the browser's native paste event, so intercepting it would paste twice.
        if (e.key === 'c') {
          const selection = xterm.getSelection();
          if (!selection) return true;
          void navigator.clipboard?.writeText(selection);
          e.preventDefault();
          return false;
        }
        const seq = MAC_LINE_EDITS[e.key];
        if (!seq) return true;
        e.preventDefault(); // stop the browser's ⌘←/⌘→ history navigation
        wsManager.write(stream, term, seq);
        return false; // consume: xterm must not also emit its default bytes
      });
    }

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
      oscForeground.dispose();
      oscBackground.dispose();
      fileLinks?.dispose();
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
