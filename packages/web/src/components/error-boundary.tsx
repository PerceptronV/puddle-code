import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The net under a render throw. React unmounts the whole tree it cannot render,
 * so without a boundary ANY exception in render or in a commit-phase effect
 * leaves an empty `#root` — a white window with no message, no way back, and
 * nothing on screen to report. That is exactly how two releases shipped
 * (v0.0.22's hook-count change and v0.0.23's duplicate pane ids): the bugs were
 * ordinary, the blank window was the amplifier.
 *
 * Boundaries do not fix bugs and must not hide them — the error goes to the
 * console with its component stack, the message is shown verbatim rather than
 * softened, and the state persists until the user acts. What it buys is a legible
 * failure and a way out.
 *
 * Mounted twice, on purpose:
 *  - around the ROUTED view (`ShellLayout`), keyed by pathname, so a crash in a
 *    workspace leaves the top bar alive — the shell still navigates, and walking
 *    away from the broken route clears the boundary with no reload at all;
 *  - at the ROOT (`App`), which catches what is left: the shell itself, the
 *    providers, the token gate.
 *
 * A crash costs no work: sessions, agents, and worktrees live in the daemon, and
 * the layout is persisted server-side — the copy says so, because a blank window
 * has taught users otherwise.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; scope: string },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack: the message alone rarely names the component,
    // and this is where a bug report starts.
    console.error(`Puddle: the ${this.props.scope} crashed`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-4 px-8 py-10 text-center">
        <p className="text-sm text-fg">The {this.props.scope} stopped rendering.</p>
        <p className="max-w-lg font-mono text-2xs leading-relaxed text-interrupted">
          {error.message || String(error)}
        </p>
        <p className="max-w-sm text-2xs leading-relaxed text-fg-muted">
          Your sessions and their worktrees are on the daemon and untouched; the layout is saved.
          The console has the full stack.
        </p>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="text-2xs font-medium text-fg-gold transition-colors hover:underline"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-2xs text-fg-muted transition-colors hover:text-fg"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
