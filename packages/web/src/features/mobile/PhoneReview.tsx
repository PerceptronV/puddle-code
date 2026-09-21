import { useMemo, useState } from 'react';
import { createTwoFilesPatch } from 'diff';
import { useQuery } from '@tanstack/react-query';
import {
  diffResponseSchema,
  fileAtResponseSchema,
  fileResponseSchema,
  treeResponseSchema,
} from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api';

/** Source is rendered as text only. Active previews never enter this origin. */
export function PhoneReview({ session }: { session: string }) {
  const [mode, setMode] = useState<'changes' | 'files'>('changes');
  const [directory, setDirectory] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [baseline, setBaseline] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const changes = useQuery({
    queryKey: ['phone-diff', session],
    queryFn: async () =>
      diffResponseSchema.parse(await api('GET', `/api/worktrees/${session}/diff?against=base`)),
    enabled: mode === 'changes',
  });
  const tree = useQuery({
    queryKey: ['phone-tree', session, directory],
    queryFn: async () =>
      treeResponseSchema.parse(
        await api(
          'GET',
          `/api/worktrees/${session}/tree?path=${encodeURIComponent(directory || '.')}`,
        ),
      ),
    enabled: mode === 'files',
  });
  const file = useQuery({
    queryKey: ['phone-file', session, path, baseline, showDiff, changes.data?.against],
    queryFn: async () => {
      if (baseline && !showDiff && changes.data) {
        const entry = changes.data.entries.find((entry) => entry.path === path);
        if (entry?.status === 'added') return { content: '', binary: false };
        return fileAtResponseSchema.parse(
          await api(
            'GET',
            `/api/worktrees/${session}/file-at?ref=${encodeURIComponent(changes.data.against)}&path=${encodeURIComponent(entry?.old_path ?? path!)}`,
          ),
        );
      }
      if (
        mode === 'changes' &&
        changes.data?.entries.find((entry) => entry.path === path)?.status === 'deleted'
      )
        return { content: '', binary: false };
      return fileResponseSchema.parse(
        await api('GET', `/api/worktrees/${session}/file?path=${encodeURIComponent(path!)}`),
      );
    },
    enabled: path !== null,
  });
  const before = useQuery({
    queryKey: ['phone-before', session, path, changes.data?.against],
    queryFn: async () => {
      const entry = changes.data!.entries.find((entry) => entry.path === path);
      if (entry?.status === 'added') return { content: '', binary: false };
      return fileAtResponseSchema.parse(
        await api(
          'GET',
          `/api/worktrees/${session}/file-at?ref=${encodeURIComponent(changes.data!.against)}&path=${encodeURIComponent(entry?.old_path ?? path!)}`,
        ),
      );
    },
    enabled: !!path && mode === 'changes' && showDiff && !!changes.data,
  });
  const patch = useMemo(() => {
    if (
      !showDiff ||
      mode !== 'changes' ||
      !before.data ||
      !file.data ||
      before.data.binary ||
      file.data.binary
    )
      return null;
    // Bound pathological diffs; the original text remains available through Before/After.
    return (
      createTwoFilesPatch(
        path!,
        path!,
        before.data.content ?? '',
        file.data.content ?? '',
        '',
        '',
        { context: 3, timeout: 100 },
      ) ?? 'Diff is too large. Use Before and After to review the text.'
    );
  }, [showDiff, mode, before.data, file.data, path]);
  const error = changes.error ?? tree.error ?? file.error ?? before.error;
  return (
    <section className="phone-review">
      <nav>
        <Button
          variant="ghost"
          onClick={() => {
            setMode('changes');
            setPath(null);
            setShowDiff(true);
          }}
        >
          Changes
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setMode('files');
            setPath(null);
            setBaseline(false);
            setShowDiff(false);
          }}
        >
          Files
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            void changes.refetch();
            void tree.refetch();
            if (path) void file.refetch();
          }}
        >
          Refresh
        </Button>
      </nav>
      {path === null ? (
        mode === 'changes' ? (
          <>
            <p>Changes against {changes.data?.base_ref ?? 'base'}</p>
            {changes.data?.entries.map((entry) => (
              <Button
                variant="ghost"
                className="phone-file"
                key={entry.path}
                onClick={() => setPath(entry.path)}
              >
                {entry.path} · {entry.status}
              </Button>
            ))}
            {changes.data?.entries.length === 0 && <p>No changes.</p>}
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}
            >
              Up · {directory || '/'}
            </Button>
            {tree.data?.entries.map((entry) => (
              <Button
                variant="ghost"
                className="phone-file"
                key={entry.name}
                disabled={entry.type === 'symlink'}
                onClick={() => {
                  const next = [directory, entry.name].filter(Boolean).join('/');
                  if (entry.type === 'dir') setDirectory(next);
                  else setPath(next);
                }}
              >
                {entry.name}
                {entry.type === 'dir' ? '/' : ''}
              </Button>
            ))}
          </>
        )
      ) : (
        <>
          <Button variant="ghost" onClick={() => setPath(null)}>
            Back
          </Button>
          <span>{path} · read only</span>
          {mode === 'changes' && (
            <nav>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowDiff(true);
                  setBaseline(false);
                }}
                aria-pressed={showDiff}
              >
                Diff
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowDiff(false);
                  setBaseline(true);
                }}
                aria-pressed={!showDiff && baseline}
              >
                Before
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowDiff(false);
                  setBaseline(false);
                }}
                aria-pressed={!showDiff && !baseline}
              >
                After
              </Button>
            </nav>
          )}
          {file.data?.binary || (showDiff && before.data?.binary) ? (
            <p>Binary file; preview unavailable.</p>
          ) : (
            <pre tabIndex={0}>
              {showDiff && mode === 'changes'
                ? (patch ?? 'Loading…')
                : (file.data?.content ?? 'Loading…')}
            </pre>
          )}
        </>
      )}
      {error && <p role="alert">{error.message}</p>}
    </section>
  );
}
