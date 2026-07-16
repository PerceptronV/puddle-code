import { useEffect, useMemo, useState } from 'react';
import { CaseSensitive, File as FileIcon, Regex, WholeWord } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { useWorktreeSearch } from '../../lib/worktree-queries';
import { cn } from '../../lib/utils';
import { buildMatcher, splitHighlight, trimPreview } from './search-highlight';

const DEBOUNCE_MS = 250;

/** A borderless toggle (HUMANS.md): accent-blue fill-shift when on. */
function Toggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            'rounded-sm p-1 transition-colors',
            active ? 'bg-elevated text-accent' : 'text-fg-muted hover:bg-elevated hover:text-fg',
          )}
        >
          {children}
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The Search navigator (SPEC §8): filename + content search over the bound
 * worktree, Obsidian-style — one query returns a "Files" section (name matches)
 * and a "Contents" section (per-file line matches). Case / whole-word / regex
 * toggles mirror the daemon's `git grep`. Clicking a filename opens the file;
 * clicking a content match opens it at that line. The query is debounced.
 */
export function SearchNav({
  session,
  onOpen,
}: {
  session: string;
  onOpen: (path: string, line?: number) => void;
}) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);

  // Debounce the typed query so a keystroke doesn't spawn a grep per character.
  useEffect(() => {
    const id = setTimeout(() => setQuery(input), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [input]);

  const params = { query, regex, caseSensitive, wholeWord };
  const search = useWorktreeSearch(session, params);
  const matcher = useMemo(() => buildMatcher(params), [query, regex, caseSensitive, wholeWord]);

  const data = search.data;
  const hasResults = !!data && (data.files.length > 0 || data.content.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1 px-2 py-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search files and contents"
          spellCheck={false}
          autoComplete="off"
          className="rounded-md bg-elevated px-2 py-1 font-mono text-xs text-fg outline-none placeholder:text-fg-muted"
        />
        <div className="flex items-center gap-1">
          <Toggle
            active={caseSensitive}
            label="Match case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            <CaseSensitive className="size-3.5" />
          </Toggle>
          <Toggle
            active={wholeWord}
            label="Match whole word"
            onClick={() => setWholeWord((v) => !v)}
          >
            <WholeWord className="size-3.5" />
          </Toggle>
          <Toggle active={regex} label="Use regular expression" onClick={() => setRegex((v) => !v)}>
            <Regex className="size-3.5" />
          </Toggle>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {query.length === 0 ? (
          <div className="px-3 py-2 text-xs text-fg-muted">Search file names and contents.</div>
        ) : search.isPending ? (
          <div className="px-3 py-2 text-xs text-fg-muted">Searching…</div>
        ) : search.error ? (
          <div className="px-3 py-2 text-xs text-fg-muted">
            {search.error instanceof Error ? search.error.message : 'Search failed'}
          </div>
        ) : !hasResults ? (
          <div className="px-3 py-2 text-xs text-fg-muted">No results.</div>
        ) : (
          <>
            {data!.files.length > 0 && (
              <section>
                <div className="px-3 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide text-fg-gold">
                  Files
                </div>
                {data!.files.map((path) => (
                  <button
                    key={path}
                    type="button"
                    title={path}
                    onClick={() => onOpen(path)}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left transition-colors hover:bg-elevated"
                  >
                    <FileIcon className="size-3.5 shrink-0 text-fg-gold" />
                    <span className="truncate font-mono text-xs text-fg">{path}</span>
                  </button>
                ))}
              </section>
            )}

            {data!.content.length > 0 && (
              <section>
                <div className="px-3 pb-0.5 pt-2 text-2xs font-medium uppercase tracking-wide text-fg-gold">
                  Contents
                </div>
                {data!.content.map((file) => (
                  <div key={file.path}>
                    <div
                      className="truncate px-3 py-1 font-mono text-2xs text-fg-secondary"
                      title={file.path}
                    >
                      {file.path}
                    </div>
                    {file.matches.map((match, i) => (
                      <button
                        key={`${match.line}:${i}`}
                        type="button"
                        onClick={() => onOpen(file.path, match.line)}
                        className="flex w-full items-baseline gap-2 py-0.5 pl-6 pr-3 text-left transition-colors hover:bg-elevated"
                      >
                        <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-muted">
                          {match.line}
                        </span>
                        <span className="truncate font-mono text-2xs text-fg-secondary">
                          {splitHighlight(trimPreview(match.text), matcher).map((seg, j) =>
                            seg.hit ? (
                              <span key={j} className="text-accent">
                                {seg.text}
                              </span>
                            ) : (
                              <span key={j}>{seg.text}</span>
                            ),
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </section>
            )}

            {data!.truncated && (
              <div className="px-3 py-2 text-2xs text-fg-muted">
                Showing the first results — refine the query for more.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
