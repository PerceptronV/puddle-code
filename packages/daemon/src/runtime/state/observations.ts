import {
  RUNTIME_LIMITS,
  runtimeEnvDeltaSchema,
  type RuntimeEnvDelta,
  type RuntimeLaunch,
} from '@puddle/shared';
import { ENV_NAME_RE, MAX_NAME_BYTES, type EnvDelta } from '../../pty/env-osc.js';
import { isDeniedEnvName } from '../../pty/shell-hooks.js';

/** Runtime admission policy; values travel only through the private ordered journal. */
export class RuntimeObservations {
  private readonly values: Map<string, string>;
  private enabled: boolean;
  private readonly warned = new Set<string>();

  constructor(capture: RuntimeLaunch['capture_env']) {
    this.enabled = capture?.enabled ?? false;
    this.values = new Map(
      Object.entries(capture?.values ?? {}).filter(([name]) => !isDeniedEnvName(name)),
    );
  }

  state() {
    return { enabled: this.enabled, count: this.values.size };
  }
  /** Spawn-only private copy; never put values in inspection or terminal output. */
  environment(): Record<string, string> {
    return this.enabled ? Object.fromEntries(this.values) : {};
  }
  configure(enabled: boolean): void {
    this.enabled = enabled;
  }
  clear(): void {
    this.values.clear();
    this.warned.clear();
  }

  observe(delta: EnvDelta, warn: (message: string) => void): RuntimeEnvDelta | null {
    if (
      !this.enabled ||
      !ENV_NAME_RE.test(delta.name) ||
      Buffer.byteLength(delta.name) > MAX_NAME_BYTES ||
      isDeniedEnvName(delta.name)
    )
      return null;
    const parsed = runtimeEnvDeltaSchema.safeParse(delta);
    if (!parsed.success) {
      this.note(delta.name, 'its value or name is invalid or exceeds its limit', warn);
      return null;
    }
    if (parsed.data.op === 'unset') this.values.delete(parsed.data.name);
    else {
      if (
        !this.values.has(parsed.data.name) &&
        this.values.size >= RUNTIME_LIMITS.environmentVariables
      ) {
        this.note(
          parsed.data.name,
          `the runtime already holds ${RUNTIME_LIMITS.environmentVariables} captured vars`,
          warn,
        );
        return null;
      }
      this.values.set(parsed.data.name, parsed.data.value);
    }
    return parsed.data;
  }

  private note(name: string, reason: string, warn: (message: string) => void): void {
    // A hostile worktree can report arbitrary names; warning deduplication is bounded too.
    if (this.warned.has(name) || this.warned.size >= RUNTIME_LIMITS.environmentVariables) return;
    this.warned.add(name);
    warn(`captured env: ${name} not persisted — ${reason}`);
  }
}
