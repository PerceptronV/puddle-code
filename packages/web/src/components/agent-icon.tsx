import { UserRound } from 'lucide-react';

/**
 * Brand marks for the coding agents puddle drives, drawn to match lucide's
 * currentColor + `size-*` convention so they drop in wherever a lucide icon
 * would. An unknown agent falls back to the neutral person glyph. Keyed off the
 * adapter's `agent_type` id (e.g. 'claude-code', 'codex') — see the adapters in
 * packages/daemon/src/agents/.
 */

/** The Claude spark: a radial burst of blades from a single centre. */
function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden
    >
      {/* long blades */}
      <line x1="12" y1="12" x2="22" y2="12" />
      <line x1="12" y1="12" x2="17" y2="20.66" />
      <line x1="12" y1="12" x2="7" y2="20.66" />
      <line x1="12" y1="12" x2="2" y2="12" />
      <line x1="12" y1="12" x2="7" y2="3.34" />
      <line x1="12" y1="12" x2="17" y2="3.34" />
      {/* short blades */}
      <line x1="12" y1="12" x2="17.63" y2="15.25" />
      <line x1="12" y1="12" x2="12" y2="18.5" />
      <line x1="12" y1="12" x2="6.37" y2="15.25" />
      <line x1="12" y1="12" x2="6.37" y2="8.75" />
      <line x1="12" y1="12" x2="12" y2="5.5" />
      <line x1="12" y1="12" x2="17.63" y2="8.75" />
    </svg>
  );
}

/** The Codex blossom: three interlocking petals about a shared centre. */
function CodexMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden
    >
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="4" ry="9" transform="rotate(120 12 12)" />
    </svg>
  );
}

/** Picks the brand mark for an agent type, or the neutral person fallback. */
export function AgentIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case 'claude-code':
      return <ClaudeMark className={className} />;
    case 'codex':
      return <CodexMark className={className} />;
    default:
      return <UserRound className={className} />;
  }
}
