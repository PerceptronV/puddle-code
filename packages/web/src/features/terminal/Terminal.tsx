import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { HOME_STREAM, type SessionStatus } from '@puddle/shared';
import { tokenStore } from '../../lib/auth';
import { useClientSettings } from '../../lib/client-settings';
import {
  actionForBinding,
  eventBinding,
  getHotkeyAction,
  getHotkeyHandler,
} from '../../lib/hotkeys';
import { daemonAnswersColourQueries } from '../../lib/protocol-support';
import { useDaemonVersion, useProfileSettings } from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';
import { useDocumentVisible } from '../../lib/use-document-visible';
import { sshMode } from '../../lib/ssh-mode';
import { cssTokenReader, onThemeChange, xtermThemeFromCss } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { wsManager } from '../../lib/ws';
import { dynamicColourReport, type DynamicColourCode } from './osc-colour';
import { isCopyShortcut } from './copy-shortcut';
import { interceptImagePaste } from './paste-image';
import { rewriteTerminalUri } from './proxy-links';
import { registerFileLinks, type FileLinkTarget } from './file-links';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The terminal typeface, and a gate on its webfont being LOADED: xterm
 * measures its cell metrics once, when the terminal opens, so a terminal
 * created while 'Ubuntu Sans Mono' was still downloading measured — and kept —
 * the fallback mono: wrong face, wrong cell geometry, until some later
 * renderer swap happened to rebuild the glyph atlas (the "reload sometimes
 * paints terminals in another font" bug, fixed 2026-08-06). The face loads
 * once per page, so the gate costs at most a frame or two on the first
 * terminal after a cold reload and nothing after; the attach replay repaints
 * the buffer, so nothing is lost by waiting.
 */
const TERMINAL_FONT = "'Ubuntu Sans Mono', ui-monospace, monospace";
const FONT_PROBE = "12px 'Ubuntu Sans Mono'"; // loads the FACE — size is irrelevant
let terminalFontReady =
  typeof document === 'undefined' || !('fonts' in document) || document.fonts.check(FONT_PROBE);
const terminalFontLoad: Promise<void> | null = terminalFontReady
  ? null
  : document.fonts
      .load(FONT_PROBE)
      .catch(() => undefined) // a face that cannot load must not block terminals
      .then(() => {
        terminalFontReady = true;
      });

function useTerminalFontReady(): boolean {
  const [ready, setReady] = useState(terminalFontReady);
  useEffect(() => {
    if (ready || terminalFontLoad === null) return;
    let live = true;
    void terminalFontLoad.then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

/** Statuses in which a process is attached to the PTY (see the restart refit). */
const LIVE_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting_input'];

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
  /** Cmd/Ctrl+click on a validated path opens it — a file in the editor, a directory in the file tree (SPEC §7). */
  onOpenFile?: (target: FileLinkTarget) => void;
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
  // Both the mount and attach effects key on this: xterm must not exist —
  // let alone measure glyphs — before the webfont it measures is loaded.
  const fontReady = useTerminalFontReady();
  // ≥14.1 the DAEMON answers OSC 10/11 colour queries (it sees the query at
  // agent spawn, before any viewer attaches — see protocol-support); this
  // viewer must then stay silent or the agent gets two replies. Optimistic
  // while the version query is in flight, like every gate.
  const daemonAnswersColours = daemonAnswersColourQueries(useDaemonVersion().data?.protocol);
  // Whether app shortcuts win over the terminal — a PROFILE setting living
  // with the hotkeys it governs (Settings → Hotkeys), default on. A ref so the
  // live xterm's key handler reads the current choice; absent/loading reads
  // as the default.
  const profileId = useCurrentProfileId();
  const appShortcuts =
    useProfileSettings(profileId ?? undefined).data?.terminalAppShortcuts !== false;
  const appShortcutsRef = useRef(appShortcuts);
  appShortcutsRef.current = appShortcuts;

  /**
   * Re-measure the grid against the container, repaint it, and tell the PTY: the
   * whole recovery for "the geometry — or the process drawing into it — changed
   * under us". Idempotent and cheap, so anything that suspects a stale grid can
   * just call it. A container with no size yet is left alone (a parked pane keeps
   * its last size rather than collapsing to 1×1).
   */
  const refit = useCallback(() => {
    const xterm = xtermRef.current;
    const container = containerRef.current;
    if (!xterm || !container || container.clientWidth === 0) return;
    fitRef.current?.fit();
    // fit() short-circuits when cols/rows come out unchanged, so force the
    // buffer resize: BufferService.resize fires onResize unconditionally, which
    // is what re-syncs the viewport's scroll range (see the attach effect) and
    // what makes the repaint below cover a canvas the renderer thinks is clean.
    xterm.resize(xterm.cols, xterm.rows);
    // Repaint every row after a geometry change: the WebGL renderer's canvas
    // clears on resize but only rows it considers dirty repaint, which could
    // blank the static part of a TUI (typically the bottom half) until a
    // selection forced a full pass (fixed 2026-07-31).
    xterm.refresh(0, xterm.rows - 1);
    wsManager.resize(stream, term, xterm.cols, xterm.rows);
  }, [stream, term]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !fontReady) return;

    // URL links are safe everywhere (login terminals included): plain click or
    // cmd/ctrl+click both open the URL in a new tab (SPEC §7). In SSH mode a
    // host-localhost URL is rewritten to the tier-2 proxy path so it works
    // from the client; login and home terminals have no session to proxy through.
    const sessionless = stream.startsWith('login-') || stream === HOME_STREAM;
    const openUri = (uri: string) => {
      const target = sessionless
        ? uri
        : rewriteTerminalUri(uri, stream, sshMode() !== null, tokenStore.get());
      window.open(target, '_blank', 'noopener,noreferrer');
    };

    const xterm = new XTerm({
      theme: xtermThemeFromCss(),
      fontFamily: TERMINAL_FONT,
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      cursorBlink: true,
      // A TUI that enables mouse reporting (Claude Code does, for wheel
      // scrolling) receives mouse drags itself — xterm then makes no local
      // selection, so ⌘C has nothing to copy even though a plain shell copies
      // fine. Shift+drag always forces a local selection; this makes ⌥+drag
      // do the same on Mac, matching Terminal.app/iTerm convention.
      macOptionClickForcesSelection: IS_MAC,
      // OSC 8 hyperlinks (how Claude Code prints its URLs, e.g. the login
      // OAuth link). Without a handler xterm falls back to a native confirm()
      // ("This link could potentially be dangerous") and then opens a BLANK
      // window before assigning its location — which the desktop shell's
      // window-open handler denies (about:blank is not https?:), so accepting
      // the dialogue opened nothing (fixed 2026-08-05). Route them through the
      // same open path as the web-links addon below: no dialogue, real URL.
      linkHandler: { activate: (_event, uri) => openUri(uri) },
    });
    xtermRef.current = xterm;
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon((_event, uri) => openUri(uri)));
    xterm.open(container);
    fit.fit();
    fitRef.current = fit;

    // Validated file-path links: only for real sessions (login/home PTYs have
    // no worktree to resolve against) and only when a handler is wired.
    const fileLinks =
      onOpenFileRef.current && !sessionless
        ? registerFileLinks(xterm, stream, (target) => onOpenFileRef.current?.(target))
        : null;

    // The last OSC 52 payload an agent asked to copy, NOT yet on the clipboard.
    // A mouse-reporting TUI (Claude Code) copies on EVERY drag selection, so
    // committing it immediately meant highlighting clobbered the clipboard
    // (decision 2026-07-31): the copy shortcut below is what commits it.
    const osc52 = { stash: null as string | null };

    const stdin = xterm.onData((data) => {
      // Not just typing: xterm CORE answers device queries (ESC[6n cursor
      // position, ESC[c device attributes, …) through this same event. During
      // a replay those are answers to HISTORICAL queries whose asker is long
      // gone, so forwarding them typed `^[[37;143R` junk into the shell's
      // input line on every re-attach (the OSC handlers below already guard
      // replay; this is the CSI-level equivalent). Auto-replies fire
      // synchronously inside the replay write, so the gate drops exactly
      // them — at worst also a keystroke typed mid-repaint.
      if (replayingRef.current) return;
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
    //
    // COMPATIBILITY PATH ONLY (pre-14.1 daemons): a ≥14.1 daemon answers these
    // itself, from the colours the shell reports over the WS — it sees the
    // query at agent SPAWN, before any viewer attaches, which is why the
    // viewer-side answer alone left auto-theming agents dark. Registering here
    // too would double-reply.
    const answerColour = (code: DynamicColourCode, token: string) => (data: string) => {
      if (data !== '?') return false; // a set request, not a query — leave it to xterm
      if (replayingRef.current) return true; // a historical query — never re-answer it
      const report = dynamicColourReport(code, cssTokenReader()(token));
      if (report) wsManager.write(stream, term, report);
      return true;
    };
    const oscForeground = daemonAnswersColours
      ? null
      : xterm.parser.registerOscHandler(10, answerColour(10, '--text-primary'));
    const oscBackground = daemonAnswersColours
      ? null
      : xterm.parser.registerOscHandler(11, answerColour(11, '--bg-base'));

    // OSC 52 clipboard *writes* land in the stash, not the clipboard: xterm.js
    // takes no action on OSC 52 on its own, and a mouse-reporting agent
    // (Claude Code) emits `OSC 52 ; c ; <base64>` for every drag selection —
    // committing directly meant highlighting auto-copied. The copy shortcut
    // commits the stash instead. Read requests (`?`) are ignored on purpose:
    // the PTY must never be able to exfiltrate the clipboard.
    //
    // This covers the escape-sequence half only. An agent that ALSO writes the
    // host clipboard itself (Claude Code shells out to pbcopy/xclip unless it
    // believes it is remote) reaches the pasteboard from the daemon's side of
    // the wire, where no browser can intervene — with a local daemon that is the
    // same pasteboard as the user's, so highlighting appears to copy despite
    // this. That is the agent's own setting to turn off (`copyOnSelect` in
    // Claude Code's /config); see the finding in agents/claude-code.ts.
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
      // App shortcuts win over the terminal (client setting, default ON): a
      // chord bound to a registered app action — ⌃⇥ tab cycling, ⌘K — must
      // not be eaten by xterm and sent to the PTY as bytes. Returning false
      // WITHOUT preventDefault makes xterm skip the key entirely, so the
      // event bubbles to the window dispatcher (HotkeysHost) that runs the
      // action. Actions the registry marks terminal-owned (`deferInTerminal`,
      // e.g. ⌃A/⌃`) or editor-bound stay with the terminal, exactly as the
      // dispatcher itself would yield them.
      if (e.type === 'keydown' && appShortcutsRef.current) {
        const binding = eventBinding(e);
        const id = binding !== null ? actionForBinding(binding) : undefined;
        const action = id !== undefined ? getHotkeyAction(id) : undefined;
        if (
          id !== undefined &&
          action !== undefined &&
          !action.editor &&
          !action.deferInTerminal &&
          getHotkeyHandler(id) !== undefined
        ) {
          return false;
        }
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

    // Focus wins the PTY size (tmux's `window-size latest`, SPEC §6). The PTY
    // has one size and every viewer's attach/resize claims it, so with the
    // same session open in two windows the OTHER window's re-attach shrinks
    // the PTY under this one — the TUI redraws for the small grid and this
    // viewer shows it faithfully: content top-left, bottom and right blank,
    // healed only by a reload re-sending these dims. Clicking into a terminal
    // is the moment the user declares which window is in use, so re-assert
    // this viewer's size then. When the sizes already agree this is a no-op
    // end to end (fit() finds nothing to change and a same-size PTY resize
    // raises no SIGWINCH).
    const onFocusIn = () => refit();
    container.addEventListener('focusin', onFocusIn);

    const observer = new ResizeObserver(() => refit());
    observer.observe(container);

    const unsubscribeTheme = onThemeChange(() => {
      xterm.options.theme = xtermThemeFromCss();
    });

    return () => {
      container.removeEventListener('paste', onPaste, true);
      container.removeEventListener('focusin', onFocusIn);
      observer.disconnect();
      unsubscribeTheme();
      oscForeground?.dispose();
      oscBackground?.dispose();
      oscClipboard.dispose();
      fileLinks?.dispose();
      stdin.dispose();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
    // Deliberately keyed on the PTY identity only — plus the one-way font
    // gate: recreating the terminal on settings change would drop scrollback;
    // the effect below patches the live instance instead. (`refit` is keyed
    // on the same two, so listing it adds no churn.) `daemonAnswersColours`
    // settles before terminals normally mount and at worst recreates once,
    // early, against a pre-14.1 daemon.
  }, [stream, term, refit, fontReady, daemonAnswersColours]);

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
    // `fontReady` because the attach reads xtermRef, a REF: when the font gate
    // flips and the mount effect above finally creates the terminal, nothing
    // else would re-run this to attach it.
  }, [stream, term, attached, fontReady]);

  // Font size and scrollback patch the LIVE instance (recreating it would drop
  // scrollback). A font change resizes the CELL, not the container, so the
  // ResizeObserver never fires for it: without refitting here the grid kept the
  // old cols/rows and the terminal stopped filling its pane — smaller type left
  // a margin of dead ground, larger type wrapped and overflowed (fixed
  // 2026-08-04). `refit` also tells the PTY, so the agent's TUI redraws itself
  // at the size actually on screen.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.fontSize = settings.terminalFontSize;
    xterm.options.scrollback = settings.terminalScrollback;
    refit();
  }, [settings.terminalFontSize, settings.terminalScrollback, refit]);

  // A FRESH PTY under an attached viewer (a resume, or an account migration —
  // "stop the process, repoint the account, resume", SPEC §5) needs the same
  // treatment: nothing else re-sizes or repaints then, since the viewer is
  // already attached (no new `attach`) and its container never changed (no
  // resize). The status feed is the signal — a session becoming live again after
  // being anything else means a new process is drawing into this buffer — and
  // the daemon starts that PTY at the size this viewer last asked for, so the
  // refit's job is to repaint and to re-assert the size if it drifted meanwhile.
  useEffect(() => {
    // Only a spawn can take a session from a dead status back to a live one, so
    // that edge IS the new process. `waiting_input` is a live status here on
    // purpose: it alternates with `running` every turn of a conversation, and
    // treating it as dead would refit on each of them.
    let wasLive = false; // nothing seen yet ⇒ the first live report is a start
    return wsManager.onStatus((e) => {
      if (e.session !== stream) return;
      const live = LIVE_STATUSES.includes(e.status);
      if (live && !wasLive) refit();
      wasLive = live;
    });
  }, [stream, refit]);

  return <div ref={containerRef} className={cn('size-full', className)} />;
}
