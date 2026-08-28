import type {
  CompilationArtifact,
  CompilationFileTarget,
  CompilationProvider as CompilationProviderDescriptor,
} from '@puddle/shared';

export interface CompilationProviderCapability {
  available: boolean;
  executor: string | null;
}

/** Provider output before the orchestrator assigns its monotonic revision. */
export interface CompilationProviderResult {
  executor: string;
  source: CompilationFileTarget;
  artifacts: CompilationArtifact[];
  navigation?: { kind: string };
  /** Absolute source-side files whose changes should trigger an eager rebuild. */
  dependencies: string[];
}

/** One language/toolchain implementation behind the generic compile service. */
export interface CompilationProvider {
  readonly id: string;
  readonly displayName: string;
  readonly extensions: readonly string[];
  readonly inputExtensions: readonly string[];
  readonly eager: boolean;
  capability(): CompilationProviderCapability;
  /** Inputs available before a successful build discovers richer dependencies. */
  watchInputs(source: CompilationFileTarget): string[];
  run(source: CompilationFileTarget): Promise<CompilationProviderResult>;
  dispose?(): void;
}

export function descriptorOf(provider: CompilationProvider): CompilationProviderDescriptor {
  const capability = provider.capability();
  return {
    id: provider.id,
    display_name: provider.displayName,
    extensions: [...provider.extensions],
    input_extensions: [...provider.inputExtensions],
    available: capability.available,
    executor: capability.executor,
    eager: provider.eager,
  };
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}
