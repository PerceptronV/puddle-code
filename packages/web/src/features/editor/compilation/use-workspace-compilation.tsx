import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type {
  CompilationFileTarget,
  CompilationFailure,
  CompilationMode,
  CompilationRunResponse,
  CompilationSettingsRequest,
  Session,
} from '@puddle/shared';
import { toast } from 'sonner';
import {
  compilationSupported,
  compilationSettingsSupported,
} from '../../../lib/transport/protocol-support';
import {
  setCompilationMode as setHostCompilationMode,
  useCompilationCapabilities,
  useRunCompilation,
} from '../../../lib/queries/compilation-queries';
import { toastError } from '../../../lib/transport/errors';
import { basename } from '../../explorer/explorer-paths';
import { runOpenNotebook } from '../notebooks/notebook-run-registry';
import { saveCompilationInputs } from '../buffers/save-registry';
import { previewKind } from '../previews/preview-kind';
import { bumpMediaRefresh } from '../previews/media-refresh-store';
import type { EditorTab } from '../tabs/editor-tabs';
import type { LayoutController } from '../../workspace/layout/useLayoutTree';
import { allLeaves, findLeaf } from '../../workspace/layout/layout-tree';
import { compilationSourceKey, sourceExtension } from './compilation-kind';
import { clearCompilationDiagnostics } from './compilation-diagnostics-store';
import { reportCompilationFailure } from './compilation-errors';
import { CompilationWatcher } from './CompilationWatcher';
import { CompilationSettingsDialog } from './CompilationSettingsDialog';

type CompilationLayout = Pick<
  LayoutController,
  'tree' | 'openEditorInLeaf' | 'setCompileMode' | 'ensureSession'
>;

/** Own compilation commands, progress, settings and result presentation for the current workspace. */
export function useWorkspaceCompilation({
  layout,
  scopeKey,
  projectId,
  profileId,
  sessions: tabSessions,
  protocol: daemonProtocol,
}: {
  layout: CompilationLayout;
  scopeKey: string;
  projectId: string;
  profileId: string | undefined;
  sessions: readonly Session[];
  protocol: Parameters<typeof compilationSupported>[0];
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const scope = `${profileId ?? ''}:${scopeKey}`;
  const current = useRef({ scope, projectId, epoch: 0 });
  if (current.current.scope !== scope || current.current.projectId !== projectId) {
    current.current = { scope, projectId, epoch: current.current.epoch + 1 };
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current.epoch++;
    };
  }, []);
  const manualRun = useRef(false);
  const modeRequests = useRef(new Map<string, symbol>());
  const compilationCapabilities = useCompilationCapabilities(compilationSupported(daemonProtocol));
  const commandSettingsAvailable = compilationSettingsSupported(daemonProtocol);
  const runCompilation = useRunCompilation();
  const [compilationSettingsRequest, setCompilationSettingsRequest] =
    useState<CompilationSettingsRequest | null>(null);
  const [manualCompilationRunningKey, setManualCompilationRunningKey] = useState<string | null>(
    null,
  );
  const [eagerCompilationRunningKeys, setEagerCompilationRunningKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const compilationRunningKeys = useMemo(() => {
    const keys = new Set(eagerCompilationRunningKeys);
    if (manualCompilationRunningKey) keys.add(manualCompilationRunningKey);
    return keys;
  }, [eagerCompilationRunningKeys, manualCompilationRunningKey]);
  const availableCompilationProviders = useMemo(
    () => compilationCapabilities.data?.providers.filter((provider) => provider.available) ?? [],
    [compilationCapabilities.data],
  );
  const compilableExtensions = useMemo(
    () =>
      new Set(
        availableCompilationProviders.flatMap((provider) =>
          provider.extensions.map((extension) => extension.toLowerCase()),
        ),
      ),
    [availableCompilationProviders],
  );

  const compilationProviderForTab = useCallback(
    (tab: EditorTab) => {
      const extension = sourceExtension(tab.path);
      return extension === null
        ? undefined
        : availableCompilationProviders.find((provider) => provider.extensions.includes(extension));
    },
    [availableCompilationProviders],
  );
  const providerForTab = useCallback(
    (tab: EditorTab) => compilationProviderForTab(tab)?.id,
    [compilationProviderForTab],
  );
  const compilationScope = useCallback(
    (sessionId: string) => {
      if (profileId === undefined) return null;
      return {
        profile_id: profileId,
        project_id:
          tabSessions.find((session) => session.id === sessionId)?.project_id ?? projectId,
      };
    },
    [profileId, projectId, tabSessions],
  );
  const compilationTarget = useCallback(
    (tab: EditorTab) => {
      const provider = providerForTab(tab);
      const scope = compilationScope(tab.session);
      return {
        source: {
          session: tab.session,
          path: tab.path,
          ...(tab.root !== undefined ? { root: tab.root } : {}),
        } satisfies CompilationFileTarget,
        ...(provider !== undefined ? { provider } : {}),
        ...(scope ?? {}),
      };
    },
    [compilationScope, providerForTab],
  );
  const openCompilationSettings = useCallback(
    (source: CompilationFileTarget) => {
      if (!commandSettingsAvailable || profileId === undefined) return;
      const extension = sourceExtension(source.path);
      const provider =
        extension === null
          ? undefined
          : availableCompilationProviders.find((candidate) =>
              candidate.extensions.includes(extension),
            );
      const scope = compilationScope(source.session);
      if (!provider || !scope) return;
      setCompilationSettingsRequest({ source, provider: provider.id, ...scope });
    },
    [availableCompilationProviders, commandSettingsAvailable, compilationScope, profileId],
  );

  const presentCompilationResult = useCallback(
    (leafId: string, result: CompilationRunResponse, activate: boolean) => {
      if (
        !mounted.current ||
        current.current.scope !== scope ||
        !findLeaf(layoutRef.current.tree, leafId)
      )
        return;
      const preview = result.artifacts.find((artifact) => artifact.role === 'preview');
      if (!preview) return;
      bumpMediaRefresh(preview.file.session, preview.file.path, preview.file.root);
      void qc.invalidateQueries({
        queryKey:
          preview.file.root === undefined
            ? ['wt-file', preview.file.session, preview.file.path]
            : ['wt-file', preview.file.session, preview.file.path, preview.file.root],
        exact: true,
      });
      layoutRef.current.openEditorInLeaf(
        leafId,
        {
          session: preview.file.session,
          path: preview.file.path,
          ...(preview.file.root !== undefined
            ? { kind: 'external' as const, root: preview.file.root }
            : { kind: 'file' as const }),
          generated_by: result.provider,
          ...(previewKind(preview.file.path) ? { view: 'preview' as const } : {}),
        },
        { dedupeAcrossTree: true, activate },
      );
    },
    [qc, scope],
  );

  const onRunCompilation = useCallback(
    async (leafId: string, tab: EditorTab, executedCopy = false) => {
      if (
        !executedCopy &&
        tab.path.toLowerCase().endsWith('.ipynb') &&
        runOpenNotebook({
          session: tab.session,
          path: tab.path,
          ...(tab.root ? { root: tab.root } : {}),
        })
      )
        return;
      if (manualRun.current) return;
      const target = compilationTarget(tab);
      const provider = compilationProviderForTab(tab);
      if (!provider) return;
      const sourceKey = compilationSourceKey(tab.session, tab.path, tab.root);
      manualRun.current = true;
      const epoch = current.current.epoch;
      const active = () => mounted.current && epoch === current.current.epoch;
      setManualCompilationRunningKey(sourceKey);
      try {
        const saved = await saveCompilationInputs(
          target.source,
          new Set(provider.input_extensions),
        );
        if (!active()) return;
        if (!saved) {
          toast.error('Run cancelled because an input could not be saved');
          return;
        }
        if ((tab.compile_mode ?? 'on_demand') === 'eager') {
          layoutRef.current.setCompileMode(tab, 'on_demand');
          await setHostCompilationMode({ ...target, mode: 'on_demand' });
        }
        if (!active()) return;
        const result = await runCompilation.mutateAsync(target);
        if (!active()) return;
        clearCompilationDiagnostics(
          compilationSourceKey(result.source.session, result.source.path, result.source.root),
        );
        if (result.terminal) {
          await qc.invalidateQueries({ queryKey: ['sessions'] });
          if (!active()) return;
          void qc.invalidateQueries({ queryKey: ['project', result.terminal.project_id] });
          layoutRef.current.ensureSession(result.terminal);
          void navigate(`/project/${result.terminal.project_id}/session/${result.terminal.id}`);
          return;
        }
        presentCompilationResult(leafId, result, true);
        toast.success(
          `${provider.action === 'run' ? 'Ran' : 'Compiled'} ${basename(result.source.path)}`,
        );
      } catch (error) {
        if (active()) reportCompilationFailure(sourceKey, error);
      } finally {
        manualRun.current = false;
        if (mounted.current) setManualCompilationRunningKey(null);
      }
    },
    [
      compilationProviderForTab,
      compilationTarget,
      presentCompilationResult,
      runCompilation,
      qc,
      navigate,
    ],
  );

  const onSetCompilationMode = useCallback(
    async (tab: EditorTab, mode: CompilationMode) => {
      const previous = tab.compile_mode ?? 'on_demand';
      if (previous === mode) return;
      const provider = compilationProviderForTab(tab);
      if (!provider || (mode === 'eager' && !provider.eager)) return;
      const target = compilationTarget(tab);
      const key = compilationSourceKey(tab.session, tab.path, tab.root);
      const request = Symbol();
      const epoch = current.current.epoch;
      modeRequests.current.set(key, request);
      const active = () =>
        mounted.current &&
        epoch === current.current.epoch &&
        modeRequests.current.get(key) === request;
      let changed = false;
      try {
        if (
          mode === 'eager' &&
          !(await saveCompilationInputs(target.source, new Set(provider.input_extensions)))
        ) {
          if (active())
            toast.error('Eager compilation was not enabled because an input could not be saved');
          return;
        }
        if (!active()) return;
        layoutRef.current.setCompileMode(tab, mode);
        changed = true;
        // The mounted watcher registers eager mode. Retire on-demand explicitly.
        if (mode === 'on_demand') await setHostCompilationMode({ ...target, mode });
      } catch (error) {
        if (!active()) return;
        if (changed) layoutRef.current.setCompileMode(tab, previous);
        toastError(error);
      } finally {
        if (modeRequests.current.get(key) === request) modeRequests.current.delete(key);
      }
    },
    [compilationProviderForTab, compilationTarget],
  );

  const eagerCompilationTargets = useMemo(() => {
    const targets = new Map<
      string,
      { leafId: string; target: ReturnType<typeof compilationTarget> }
    >();
    for (const leaf of allLeaves(layout.tree)) {
      for (const ref of leaf.tabs) {
        if (ref.type !== 'editor' || ref.tab.compile_mode !== 'eager') continue;
        const provider = providerForTab(ref.tab);
        if (!provider || !compilationProviderForTab(ref.tab)?.eager) continue;
        const key = compilationSourceKey(ref.tab.session, ref.tab.path, ref.tab.root);
        if (!targets.has(key)) {
          targets.set(key, { leafId: leaf.id, target: compilationTarget(ref.tab) });
        }
      }
    }
    return [...targets.entries()].map(([key, value]) => ({ key, ...value }));
  }, [layout.tree, compilationTarget, providerForTab, compilationProviderForTab]);

  const onEagerCompilationResult = useCallback(
    (_sourceKey: string, leafId: string, result: CompilationRunResponse) => {
      clearCompilationDiagnostics(
        compilationSourceKey(result.source.session, result.source.path, result.source.root),
      );
      presentCompilationResult(leafId, result, false);
    },
    [presentCompilationResult],
  );
  const onEagerCompilationError = useCallback(
    (sourceKey: string, failure: CompilationFailure) =>
      reportCompilationFailure(sourceKey, failure),
    [],
  );
  const setEagerCompilationRunning = useCallback((key: string, running: boolean) => {
    setEagerCompilationRunningKeys((current) => {
      const has = current.has(key);
      if (has === running) return current;
      const next = new Set(current);
      if (running) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  return {
    providers: availableCompilationProviders,
    extensions: compilableExtensions,
    runningKeys: compilationRunningKeys,
    run: onRunCompilation,
    setMode: onSetCompilationMode,
    openSettings: commandSettingsAvailable ? openCompilationSettings : undefined,
    watchers: eagerCompilationTargets.map(({ key, leafId, target }) => (
      <CompilationWatcher
        key={key}
        sourceKey={key}
        leafId={leafId}
        target={target}
        inputExtensions={
          availableCompilationProviders.find((provider) => provider.id === target.provider)
            ?.input_extensions
        }
        onResult={onEagerCompilationResult}
        onError={onEagerCompilationError}
        onRunningChange={setEagerCompilationRunning}
      />
    )),
    settingsDialog: (
      <CompilationSettingsDialog
        request={compilationSettingsRequest}
        onOpenChange={(open) => !open && setCompilationSettingsRequest(null)}
      />
    ),
  };
}
