import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { HOME_STREAM } from '@puddle/shared';
import { tokenStore } from '../../lib/auth';
import { useClientSettings } from '../../lib/client-settings';
import { useDocumentVisible } from '../../lib/use-document-visible';
import { sshMode } from '../../lib/ssh-mode';
import { cssTokenReader, onThemeChange, xtermThemeFromCss } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { wsManager } from '../../lib/ws';
import { dynamicColourReport, type DynamicColourCode } from './osc-colour';
import { isCopyShortcut } from './copy-shortcut';
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
  /** PTY stream: a session uuid, `login-<accountId>`, or `home` (HOME_STREAM). */
  stream: string;
  term?: string;
  className?: string;
  onExit?: (code: number) => void;
  /** Cmd/Ctrl+click on a validated file path opens it in the editor (SPEC §7). */
  onOpenFile?: (path: string, line?: number, column?: number) => void;
  /**
   * True while this terminal's DOM is parked out of sight (a background tab in
   * the tiling layout). A paused terminal detaches its PTY viewer — no output
   * arrives, nothing is parsed — and re-attaches on unpause, where the daemon's
   * replay repaints it. The PTY and its agent run on regardless; viewers are
   * ephemeral by design (SPEC §6).
   */
  paused?: boolean;
}

/**
 * Deferred false: flips to true immediately, but holds a true value for
 * `delayMs` after the input goes false. Rapid tab switches therefore keep the
 * PTY attachment (no replay churn); only a settled pause detaches.
 */
function useLingeringTrue(value: boolean, delayMs: number): boolean {
  const [lingering, setLingering] = useState(value);
  useEffect(() => {
    if (value) {
      setLingering(true);
      return;
    }
    const timer = setTimeout(() => setLingering(false), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return lingering;
}

const DETACH_LINGER_MS = 1_500;

/**
 * One xterm bound to one daemon PTY via the WS manager. The attach replay
 * repaints prior scrollback; the theme regenerates from the CSS variables on
 * every theme switch so terminal and chrome never drift apart (SPEC §12).
 */
export function Terminal({
  stream,
  term = 'agent',
  className,
  onExit,
  onOpenFile,
  paused = false,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // True while the buffer is replaying history: OSC side effects (clipboard
  // writes, colour-query replies) must not re-fire for bytes the agent emitted
  // in the past — a stale clipboard overwrite, or a stale reply written into a
  // working agent's stdin.
  const replayingRef = useRef(false);
  const settings = useClientSettings();
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  // Also pause when the whole document is hidden: a backgrounded browser tab
  // otherwise keeps receiving and parsing every byte of PTY output.
  const visible = useDocumentVisible();
  const attached = useLingeringTrue(!paused && visible, DETACH_LINGER_MS);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const xterm = new XTerm({
      theme: xtermThemeFromCss(),
      fontFamily: "'Ubuntu Sans Mono', ui-monospace, monospace",
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      cursorBlink: true,
      // A TUI that enables mouse reporting (Claude Code does, for wheel
      // scrolling) receives mouse drags itself — xterm then makes no local
      // selection, so ⌘C has nothing to copy even though a plain shell copies
      // fine. Shift+drag always forces a local selection; this makes ⌥+drag
      // do the same on Mac, matching Terminal.app/iTerm convention.
      macOptionClickForcesSelection: IS_MAC,
    });
    xtermRef.current = xterm;
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    // URL links are safe everywhere (login terminals included): plain click or
    // cmd/ctrl+click both open the URL in a new tab (SPEC §7). In SSH mode a
    // host-localhost URL is rewritten to the tier-2 proxy path so it works
    // from the client; login and home terminals have no session to proxy through.
    const sessionless = stream.startsWith('login-') || stream === HOME_STREAM;
    xterm.loadAddon(
      new WebLinksAddon((_event, uri) => {
        const target = sessionless
          ? uri
          : rewriteTerminalUri(uri, stream, sshMode() !== null, tokenStore.get());
        window.open(target, '_blank', 'noopener,noreferrer');
      }),
    );
    xterm.open(container);
    fit.fit();
    fitRef.current = fit;

    // Validated file-path links: only for real sessions (login/home PTYs have
    // no worktree to resolve against) and only when a handler is wired.
    const fileLinks =
      onOpenFileRef.current && !sessionless
        ? registerFileLinks(xterm, stream, (path, line, column) =>
            onOpenFileRef.current?.(path, line, column),
          )
        : null;

    // The last OSC 52 payload an agent asked to copy, NOT yet on the clipboard.
    // A mouse-reporting TUI (Claude Code) copies on EVERY drag selection, so
    // committing it immediately meant highlighting clobbered the clipboard
    // (decision 2026-07-31): the copy shortcut below is what commits it.
    const osc52 = { stash: null as string | null };

    const stdin = xterm.onData((data) => {
      // Typing dismisses the TUI selection behind the stash — drop it so a
      // later copy chord cannot commit stale text. Mouse reports (wheel
      // scrolling, `ESC[<…`) are not typing and keep it.
      if (!data.startsWith('\x1b[<')) osc52.stash = null;
      wsManager.write(stream, term, data);
    });

    // Answer the terminal dynamic-colour queries (OSC 10 foreground, OSC 11
    // background) that xterm.js leaves unanswered. An agent with auto/system
    // theme detection (e.g. Claude Code) queries the background luminance to
    // choose light vs dark; without a reply it cannot match the puddle theme.
    // Tokens are read live so the answer reflects the theme at query time.
    const answerColour = (code: DynamicColourCode, token: string) => (data: string) => {
      if (data !== '?') return false; // a set request, not a query — leave it to xterm
      if (replayingRef.current) return true; // a historical query — never re-answer it
      const report = dynamicColourReport(code, cssTokenReader()(token));
      if (report) wsManager.write(stream, term, report);
      return true;
    };
    const oscForeground = xterm.parser.registerOscHandler(10, answerColour(10, '--text-primary'));
    const oscBackground = xterm.parser.registerOscHandler(11, answerColour(11, '--bg-base'));

    // OSC 52 clipboard *writes* land in the stash, not the clipboard: xterm.js
    // takes no action on OSC 52 on its own, and a mouse-reporting agent
    // (Claude Code) emits `OSC 52 ; c ; <base64>` for every drag selection —
    // committing directly meant highlighting auto-copied. The copy shortcut
    // commits the stash instead. Read requests (`?`) are ignored on purpose:
    // the PTY must never be able to exfiltrate the clipboard.
    const oscClipboard = xterm.parser.registerOscHandler(52, (data) => {
      if (replayingRef.current) return true; // a historical copy — never resurface it
      const semi = data.indexOf(';');
      const payload = semi === -1 ? '' : data.slice(semi + 1);
      if (!payload || payload === '?') return true; // read/clear — nothing to stash
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        osc52.stash = new TextDecoder().decode(bytes);
      } catch {
        // malformed base64 — nothing safe to copy
      }
      return true;
    });

    xterm.attachCustomKeyEventHandler((e) => {
      // The copy chord (⌘C on Mac, Ctrl+Shift+C elsewhere — plain Ctrl-C stays
      // the interrupt) copies the local selection, else the stashed OSC 52
      // payload; with neither it falls through and does nothing. ⌘V needs no
      // handling: xterm already pastes on the browser's native paste event, so
      // intercepting it would paste twice.
      if (isCopyShortcut(e, IS_MAC)) {
        const text = xterm.getSelection() || osc52.stash;
        if (!text) return true;
        void navigator.clipboard?.writeText(text);
        e.preventDefault();
        return false;
      }
      if (!IS_MAC) return true;
      if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return true;
      const seq = MAC_LINE_EDITS[e.key];
      if (!seq) return true;
      e.preventDefault(); // stop the browser's ⌘←/⌘→ history navigation
      wsManager.write(stream, term, seq);
      return false; // consume: xterm must not also emit its default bytes
    });

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
      // Repaint every row after a geometry change: the WebGL renderer's canvas
      // clears on resize but only rows it considers dirty repaint, which could
      // blank the static part of a TUI (typically the bottom half) until a
      // selection forced a full pass (fixed 2026-07-31).
      xterm.refresh(0, xterm.rows - 1);
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
      oscClipboard.dispose();
      fileLinks?.dispose();
      stdin.dispose();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
    // Deliberately keyed on the PTY identity only: recreating the terminal on
    // settings change would drop scrollback; the effect below patches the
    // live instance instead.
  }, [stream, term]);

  // The PTY attachment, gated on `attached`: paused/hidden terminals detach
  // (the daemon stops sending, nothing is parsed) and re-attach on return,
  // where the daemon's replay repaints the buffer from scratch. Note a session
  // that exits while detached delivers no `exit` event here; the status feed
  // carries that news to the UI.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm || !attached) return;
    // Adoption may have just given the container real dimensions — size the
    // buffer first so the attach carries the dims the PTY should have.
    const container = containerRef.current;
    if (container && container.clientWidth > 0) {
      fitRef.current?.fit();
      // Un-wedge wheel scrolling (xterm 6): the viewport syncs its scroll
      // range from the renderer's cached dimensions, and a sync that fired
      // while this DOM was parked (display:none — output during the detach
      // linger, the WebGL renderer swap) latched it at height 0, where the
      // scrollable element silently drops wheel input though typing still
      // works. fit() skips resize() when cols/rows are unchanged — the
      // normal case for a tab returning to the same pane — so nothing
      // re-syncs it. BufferService.resize fires onResize UNCONDITIONALLY,
      // so a same-size resize queues the viewport sync that re-reads the
      // now-visible dimensions (fixed 2026-07-31; this never reaches the
      // PTY — SIGWINCH only comes from the ResizeObserver's real resizes).
      xterm.resize(xterm.cols, xterm.rows);
    }
    // GPU rendering only while attached: browsers cap live WebGL contexts
    // (~16 per page), so contexts must track the handful of visible panes,
    // never the full set of mounted terminals. Unavailable/lost context
    // falls back to xterm's DOM renderer.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
        // Back on the DOM renderer: repaint in full — the lost context may
        // have left any part of the canvas blank.
        xterm.refresh(0, xterm.rows - 1);
      });
      xterm.loadAddon(webgl);
    } catch {
      webgl = null;
    }
    // A renderer swap starts from a cleared canvas — repaint everything (the
    // same reasoning as the post-fit refresh in the ResizeObserver above).
    xterm.refresh(0, xterm.rows - 1);
    const detach = wsManager.attach(stream, term, xterm.cols, xterm.rows, {
      onData: (data, kind) => {
        if (kind === 'replay') {
          // Start from a clean screen: the replayed tail must repaint the
          // buffer, not append to what it already shows.
          replayingRef.current = true;
          xterm.reset();
          xterm.write(data, () => {
            replayingRef.current = false;
          });
          return;
        }
        xterm.write(data);
      },
      onExit: (code) => onExitRef.current?.(code),
    });
    return () => {
      webgl?.dispose();
      webgl = null;
      detach();
    };
  }, [stream, term, attached]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.fontSize = settings.terminalFontSize;
    xterm.options.scrollback = settings.terminalScrollback;
  }, [settings.terminalFontSize, settings.terminalScrollback]);

  return <div ref={containerRef} className={cn('size-full', className)} />;
}
