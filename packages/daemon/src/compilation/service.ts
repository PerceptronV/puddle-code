import type {
  CompilationCapabilitiesResponse,
  CompilationFileTarget,
  CompilationModeRequest,
  CompilationRunRequest,
  CompilationRunResponse,
  CompilationStatusResponse,
  CompilationTargetRequest,
} from '@puddle/shared';
import { ApiError } from '../http/errors.js';
import {
  descriptorOf,
  extensionOf,
  type CompilationProvider,
  type CompilationProviderResult,
} from './provider.js';
import { DependencyWatcher } from './dependency-watcher.js';

const WATCH_IDLE_TTL_MS = 6 * 60 * 60 * 1_000;

export type CompilationEvent =
  | { type: 'started'; key: string; status: CompilationStatusResponse }
  | { type: 'completed'; key: string; status: CompilationStatusResponse }
  | { type: 'failed'; key: string; status: CompilationStatusResponse };

interface TargetState {
  key: string;
  provider: CompilationProvider;
  source: CompilationFileTarget;
  status: CompilationStatusResponse;
  watcher: DependencyWatcher;
  running: Promise<CompilationRunResponse> | null;
  dirty: boolean;
  lastTouched: number;
}

/**
 * Provider-neutral on-demand/eager orchestration. Eager sources observe their
 * dependency directories, which catches both in-place writes and the atomic
 * replacement used by editors and coding agents.
 */
export class CompilationService {
  private readonly providers = new Map<string, CompilationProvider>();
  private readonly targets = new Map<string, TargetState>();
  private readonly listeners = new Set<(event: CompilationEvent) => void>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(providers: readonly CompilationProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.id))
        throw new Error(`duplicate compiler provider ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
    this.sweepTimer = setInterval(() => this.sweepIdleWatches(), 30 * 60 * 1_000);
    this.sweepTimer.unref();
  }

  capabilities(): CompilationCapabilitiesResponse {
    return { providers: [...this.providers.values()].map(descriptorOf) };
  }

  async run(request: CompilationRunRequest): Promise<CompilationRunResponse> {
    const state = this.target(request);
    state.lastTouched = Date.now();
    return this.execute(state);
  }

  async setMode(request: CompilationModeRequest): Promise<CompilationStatusResponse> {
    const state = this.target(request);
    state.lastTouched = Date.now();
    if (request.mode === 'on_demand') {
      state.status = { ...state.status, mode: 'on_demand' };
      state.watcher.close();
      return state.status;
    }
    if (!state.provider.eager) {
      throw ApiError.badRequest(
        'eager_compilation_unsupported',
        `${state.provider.displayName} does not support eager compilation`,
      );
    }
    state.status = { ...state.status, mode: 'eager' };
    // Install the provider's entry-point watchers before compiling: a broken
    // first build must remain live and retry when an editor or agent fixes it.
    state.watcher.replace(state.provider.watchInputs(state.source));
    // Registration includes an initial build, so restoring an eager tab never
    // waits for another filesystem event before it has a preview.
    await this.execute(state);
    return state.status;
  }

  status(request: CompilationTargetRequest): CompilationStatusResponse {
    const state = this.target(request);
    state.lastTouched = Date.now();
    return state.status;
  }

  subscribe(listener: (event: CompilationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    for (const state of this.targets.values()) {
      state.status = { ...state.status, mode: 'on_demand' };
      state.watcher.close();
    }
    for (const provider of this.providers.values()) provider.dispose?.();
    this.targets.clear();
    this.listeners.clear();
  }

  private target(request: CompilationTargetRequest): TargetState {
    const provider = this.selectProvider(request.source, request.provider);
    const key = targetKey(provider.id, request.source);
    const existing = this.targets.get(key);
    if (existing) return existing;
    const watcher = new DependencyWatcher(() => {
      const current = this.targets.get(key);
      if (!current) return;
      current.lastTouched = Date.now();
      void this.execute(current).catch(() => undefined);
    });
    const state: TargetState = {
      key,
      provider,
      source: request.source,
      status: {
        provider: provider.id,
        mode: 'on_demand',
        state: 'idle',
        revision: 0,
        result: null,
        error: null,
      },
      watcher,
      running: null,
      dirty: false,
      lastTouched: Date.now(),
    };
    this.targets.set(key, state);
    return state;
  }

  private selectProvider(source: CompilationFileTarget, providerId?: string): CompilationProvider {
    const provider = providerId
      ? this.providers.get(providerId)
      : [...this.providers.values()].find((candidate) =>
          candidate.extensions.includes(extensionOf(source.path)),
        );
    if (!provider) {
      throw ApiError.badRequest(
        'compiler_not_supported',
        `No compiler provider supports ${source.path}`,
      );
    }
    return provider;
  }

  private execute(state: TargetState): Promise<CompilationRunResponse> {
    if (this.disposed)
      throw ApiError.conflict('compiler_disposed', 'Compilation service is closed');
    if (state.running) {
      if (state.status.mode === 'eager') state.dirty = true;
      return state.running;
    }
    if (!state.provider.capability().available) {
      throw new ApiError(
        424,
        'compiler_not_installed',
        `${state.provider.displayName} is not available on the daemon host`,
      );
    }
    const revision = state.status.revision + 1;
    state.status = {
      ...state.status,
      state: 'running',
      revision,
      error: null,
    };
    this.emit({ type: 'started', key: state.key, status: state.status });
    state.running = state.provider
      .run(state.source)
      .then((product) => {
        const result = responseOf(state.provider, product, revision);
        state.status = {
          ...state.status,
          state: 'succeeded',
          revision,
          result,
          error: null,
        };
        if (state.status.mode === 'eager') state.watcher.replace(product.dependencies);
        this.emit({ type: 'completed', key: state.key, status: state.status });
        return result;
      })
      .catch((error: unknown) => {
        state.status = {
          ...state.status,
          state: 'failed',
          revision,
          error: { message: error instanceof Error ? error.message : String(error) },
        };
        this.emit({ type: 'failed', key: state.key, status: state.status });
        throw error;
      })
      .finally(() => {
        state.running = null;
        if (state.dirty && state.status.mode === 'eager') {
          state.dirty = false;
          void this.execute(state).catch(() => undefined);
        }
      });
    return state.running;
  }

  private sweepIdleWatches(): void {
    const cutoff = Date.now() - WATCH_IDLE_TTL_MS;
    for (const [key, state] of this.targets) {
      if (state.running || state.lastTouched >= cutoff) continue;
      state.watcher.close();
      this.targets.delete(key);
    }
  }

  private emit(event: CompilationEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function responseOf(
  provider: CompilationProvider,
  product: CompilationProviderResult,
  revision: number,
): CompilationRunResponse {
  return {
    provider: provider.id,
    executor: product.executor,
    revision,
    source: product.source,
    artifacts: product.artifacts,
    ...(product.navigation ? { navigation: product.navigation } : {}),
  };
}

function targetKey(provider: string, source: CompilationFileTarget): string {
  return JSON.stringify([provider, source.session, source.root ?? null, source.path]);
}
