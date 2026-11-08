import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  sessionSchema,
  supportsApplicationFeature,
  huddleTextEditSchema,
  type FileResponse,
  type PutFileRequest,
  type HuddleDraftBaseline,
  type HuddleSource,
} from '@puddle/shared';
import { useWorktreeFile, useSaveWorktreeFile } from '../../../lib/queries/worktree-queries';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { api, ApiError } from '../../../lib/transport/api';
import { browserTransport } from '../../../lib/transport/browser-transport';
import { currentProfileId, useCurrentProfileId } from '../../profile/profile-store';
import { desktopWindowContext } from '../../windows/window-context';
import { focusAwareInterval } from '../../../lib/queries/poll-focus';
import { capturedSource, baselineTarget } from '../../huddle/documents/source/revision';
import {
  afterOwnWrites,
  acknowledgeSourceWrite,
  queueSourceWrite,
} from '../../huddle/documents/source/writes';

export interface BufferFile extends FileResponse {
  baseRevision?: HuddleDraftBaseline;
  captured?: HuddleSource;
  repair?: boolean;
}
export interface BufferWrite extends PutFileRequest {
  path: string;
  baseRevision?: HuddleDraftBaseline;
  repairReview?: boolean;
}
export function huddleSourceScope(): string {
  return desktopWindowContext()?.hostId ?? window.location.origin;
}

/** The normal shared editor lifecycle selects its transport; every holder uses the same guard. */
export function useBufferTransport(session: string, path: string, root?: string, live?: boolean) {
  const match =
    root === undefined
      ? /^\.puddle\/huddle\/([a-f0-9]{32})\/(huddle|layout)\.json$/.exec(path)
      : null;
  const candidate = !!match && !browserTransport();
  const version = useDaemonVersion();
  const profile = useCurrentProfileId();
  const scope = huddleSourceScope();
  const guarded =
    candidate && supportsApplicationFeature(version.data?.protocol, { major: 28, minor: 11 });
  const placement = useQuery({
    queryKey: ['session', session],
    queryFn: async ({ signal }) =>
      sessionSchema.parse(await api('GET', `/api/sessions/${session}`, undefined, signal)),
    enabled: guarded,
  });
  const ordinarySave = useSaveWorktreeFile(session, root);
  const cache = useQueryClient();
  const target =
    profile && placement.data && match
      ? {
          profile,
          scope,
          project_id: placement.data.project_id,
          worktree: placement.data.worktree_path,
          huddle_id: match[1]!,
        }
      : undefined;
  const queryKey = [
    'huddle-source',
    target?.scope,
    profile,
    target?.project_id,
    target?.worktree,
    target?.huddle_id,
  ];
  const check = () => {
    if (
      !target ||
      browserTransport() ||
      currentProfileId() !== target.profile ||
      huddleSourceScope() !== target.scope
    )
      throw new Error('The huddle source connection changed');
  };
  const toFile = (capture: Awaited<ReturnType<typeof capturedSource>>): BufferFile => {
    const file = `${match![2]}.json`;
    const content = capture.source.files[file] ?? '{"format":1,"nodes":{}}\n';
    return {
      path,
      content,
      binary: false,
      size: new TextEncoder().encode(content).length,
      // A guarded buffer uses its captured revision, never a fabricated filesystem timestamp.
      mtime_ms: capture.source.files[file] === undefined ? -1 : 0,
      baseRevision: capture.baseline,
      captured: capture.source,
    };
  };
  const source = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      check();
      const { profile, scope: _, huddle_id, ...location } = target!;
      const response = await api(
        'GET',
        `/api/huddle/${profile}/definitions/${huddle_id}/source?${new URLSearchParams(location)}`,
        undefined,
        signal,
      );
      const captured = await capturedSource(target!, response);
      check();
      return captured;
    },
    enabled: guarded && !!target,
    retry: false,
    refetchOnWindowFocus: true,
    ...(live ? { refetchInterval: focusAwareInterval(3000) } : {}),
  });
  const captureInvalid = (error: unknown) =>
    error instanceof ApiError && error.code === 'huddle_definition_invalid';
  const repair = guarded && captureInvalid(source.error);
  const ordinary = useWorktreeFile(session, path, {
    root,
    live: !guarded && live,
    enabled: repair || (!guarded && (!candidate || !!version.data)),
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (
      input: BufferWrite,
    ): Promise<{ mtime_ms: number; baseRevision?: HuddleDraftBaseline }> => {
      if (!guarded) {
        if (input.baseRevision)
          throw new Error('This captured huddle draft requires a host with source-save support');
        const { baseRevision: _, repairReview: _repair, ...ordinaryInput } = input;
        return ordinarySave.mutateAsync(ordinaryInput);
      }
      check();
      const parsed = huddleTextEditSchema.safeParse({
        file: `${match![2]}.json`,
        content: input.content,
      });
      if (!parsed.success)
        throw new ApiError(
          400,
          'invalid_huddle_source',
          'Save requires a supported huddle JSON document without unknown fields',
        );
      const edit = parsed.data;
      if (edit.file === 'huddle.json' && JSON.parse(edit.content).id !== target!.huddle_id)
        throw new ApiError(
          400,
          'huddle_identity_changed',
          'A saved huddle must keep its directory id',
        );
      if (input.repairReview) {
        if (input.expected_mtime_ms === undefined)
          throw new Error('Review the file before repairing it');
        return queueSourceWrite(baselineTarget(target!), async () => {
          check();
          const result = await ordinarySave.mutateAsync({
            path,
            content: edit.content,
            expected_mtime_ms: input.expected_mtime_ms,
          });
          check();
          const fileKey = ['wt-file', session, path];
          await cache.cancelQueries({ queryKey: fileKey, exact: true });
          check();
          cache.setQueryData(fileKey, {
            path,
            content: edit.content,
            binary: false,
            size: new TextEncoder().encode(edit.content).length,
            mtime_ms: result.mtime_ms,
          });
          void cache.invalidateQueries({ queryKey });
          return result;
        });
      }
      if (!input.baseRevision || baselineTarget(input.baseRevision) !== baselineTarget(target!))
        throw new ApiError(
          409,
          'huddle_source_changed',
          'Review current huddle source before saving this draft',
        );
      return queueSourceWrite(baselineTarget(input.baseRevision), async () => {
        check();
        const before = afterOwnWrites(input.baseRevision!, edit.file);
        const { profile, scope: _, huddle_id, ...location } = target!;
        const raw = await api('PUT', `/api/huddle/${profile}/definitions/${huddle_id}/source`, {
          ...location,
          expected_digest: before.digest,
          edit,
        });
        const saved = await capturedSource(target!, raw);
        check();
        if (saved.source.files[edit.file] !== edit.content)
          throw new Error('Huddle source changed after publication; review it before another save');
        // A pre-save background read must not replace this acknowledged capture.
        await cache.cancelQueries({ queryKey, exact: true });
        check();
        acknowledgeSourceWrite(before, saved.baseline, edit.file);
        cache.setQueryData(queryKey, saved);
        void cache.invalidateQueries({ queryKey: ['huddle-document'] });
        void cache.invalidateQueries({ queryKey: ['wt-file', session, path] });
        void cache.invalidateQueries({ queryKey: ['wt-diff', session] });
        return { mtime_ms: 0, baseRevision: saved.baseline };
      });
    },
  });
  return {
    guarded,
    file: {
      data: (repair
        ? ordinary.data
          ? { ...ordinary.data, repair: true }
          : undefined
        : guarded
          ? source.data
            ? toFile(source.data)
            : undefined
          : ordinary.data) as BufferFile | undefined,
      error: repair
        ? ordinary.error
        : guarded
          ? (source.error ?? placement.error)
          : (ordinary.error ?? (candidate ? version.error : null)),
      refetch: async (options?: { throwOnError?: boolean }) => {
        if (!guarded) {
          const result = await ordinary.refetch(options);
          return { data: result.data as BufferFile | undefined };
        }
        try {
          const result = await source.refetch({ ...options, throwOnError: true });
          return { data: result.data ? toFile(result.data) : undefined };
        } catch (error) {
          if (!captureInvalid(error)) throw error;
          const result = await ordinary.refetch(options);
          return {
            data: result.data ? ({ ...result.data, repair: true } as BufferFile) : undefined,
          };
        }
      },
    },
    saveMutation: mutation,
  };
}
