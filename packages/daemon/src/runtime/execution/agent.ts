import { randomUUID } from 'node:crypto';
import {
  runtimeAgentStateSchema,
  runtimeLifecycleSchema,
  type AgentSignalRequest,
  type RuntimeAgentState,
  type RuntimeCommand,
  type RuntimeLaunch,
  type RuntimeLifecycle,
} from '@puddle/shared';
import type { AgentAdapter, AgentControl, LifecycleLaunchResource } from '../../agents/adapter.js';
import { AgentLaunchError } from '../../agents/launch-error.js';
import { StatusDetector } from '../../pty/status-detector.js';
import { RuntimeConversationClaim } from '../ownership/conversation-claim.js';
import { RuntimeSignals } from './signals.js';
import { pinRuntimeAssets } from './assets.js';
import { runtimeDirectory } from '../ownership/storage.js';
import type { RuntimeByteAllowance } from '../resources/budget.js';

interface AgentObservers {
  screen?(): Promise<string>;
  writeInput(data: string): void;
  lifecycle(signal: RuntimeLifecycle): void;
  state(state: RuntimeAgentState): void;
  collision(ref: string): void;
}

/** Live provider resources belong to the runtime, never to a controller connection. */
export class RuntimeAgent {
  private readonly nonce = randomUUID();
  private readonly signals: RuntimeSignals;
  private readonly claim: RuntimeConversationClaim;
  private readonly detector: StatusDetector;
  private resource: LifecycleLaunchResource | null = null;
  private signalPort: number | null = null;
  private lifecycleUnavailable = false;
  private nativeSync: RuntimeAgentState['native_sync'] = 'fallback';
  private status: RuntimeAgentState['status'] = 'starting';
  private ref: string | null = null;
  private signalled = false;
  private closed = false;

  constructor(
    private readonly home: string,
    private readonly launch: RuntimeLaunch,
    private readonly adapter: AgentAdapter,
    private readonly observers: AgentObservers,
    private readonly bufferAllowance?: RuntimeByteAllowance,
  ) {
    if (!launch.provider || adapter.id !== launch.provider.id)
      throw new Error('Runtime provider does not match its launch');
    this.claim = new RuntimeConversationClaim(home, launch.identity.profile_id, adapter.id);
    this.signals = new RuntimeSignals(
      this.nonce,
      (signal) => this.receive(signal),
      bufferAllowance,
    );
    this.detector = new StatusDetector(
      adapter.statusPatterns,
      {
        onStatus: (status) => {
          if (!this.signalled) this.setStatus(status);
        },
      },
      2000,
      observers.screen
        ? () => (this.signalled ? Promise.resolve('') : observers.screen!())
        : undefined,
    );
  }

  async prepare(): Promise<RuntimeCommand> {
    const provider = this.launch.provider!;
    const account = { config_dir: provider.config_dir };
    const opts = {
      sessionId: this.launch.identity.session_id,
      worktreePath: this.launch.identity.canonical_worktree_path,
      skipPermissions: provider.skip_permissions,
      ...(provider.prompt !== undefined ? { prompt: provider.prompt } : {}),
    };
    if (provider.initial_ref && (!this.adapter.capabilities.presetSessionId || provider.resume_ref))
      throw new Error('Provider cannot use this preset conversation identity');
    const launchRef = provider.resume_ref ?? provider.initial_ref;
    if (launchRef) {
      this.ref = launchRef;
      if (!this.claim.switch(launchRef)) throw new Error('Native conversation is already owned');
    }
    const signalUrl = await this.signals.listen();
    this.signalPort = Number(new URL(signalUrl).port);
    const assets = pinRuntimeAssets(
      runtimeDirectory(this.home, this.launch.identity.runtime_id),
      this.adapter.runtimeAssets?.() ?? {},
    );
    const captured = { ...this.launch.main.env };
    // Captured shell variables cannot override resources owned by this runtime.
    for (const key of [
      'PUDDLE_AGENT_HELPER_DIR',
      'PUDDLE_AGENT_HELPER_NODE',
      'PUDDLE_AGENT_TURN_STATE_DIR',
    ])
      delete captured[key];
    const env = { ...captured, ...this.adapter.env(account), ...assets };
    const args = provider.resume_ref
      ? this.adapter.resumeArgs(provider.resume_ref, opts)
      : this.adapter.launchArgs(opts);
    const headless = provider.mode === 'headless';
    const prepare = headless
      ? this.adapter.prepareHeadlessLaunch
      : this.adapter.prepareLifecycleLaunch;
    if (headless && !prepare) throw new Error('Provider has no headless control channel');
    try {
      if (prepare) {
        this.resource = await prepare({
          account,
          opts,
          bufferAllowance: this.bufferAllowance,
          reportLifecycleUnavailable: () => {
            if (this.lifecycleUnavailable) return;
            this.lifecycleUnavailable = true;
            this.nativeSync = 'fallback';
            this.publish();
          },
          args,
          signalUrl,
          signalNonce: this.nonce,
          ...(provider.resume_ref ? { resumeRef: provider.resume_ref } : {}),
          env: { ...captured, ...assets },
          writeInput: (data) => {
            if (this.closed) throw new Error('Agent runtime has exited');
            this.observers.writeInput(data);
          },
          reportStatus: (state) => this.signalStatus(state),
          bindConversation: async (ref) => {
            if (
              !this.receive({
                nonce: this.nonce,
                event: 'session_start',
                agent_session_ref: ref,
                cwd: opts.worktreePath,
                source: provider.resume_ref ? 'resume' : 'startup',
              })
            )
              throw new Error('Native conversation could not be bound');
          },
        });
        if (this.ref) this.resource.control?.lifecycle?.(this.ref, false);
        this.nativeSync = this.lifecycleUnavailable ? 'fallback' : 'full';
      } else if (
        this.adapter.lifecycleSignals &&
        (await this.adapter.checkLifecycleSupport?.(account)) === true
      ) {
        this.nativeSync = this.lifecycleUnavailable ? 'fallback' : 'full';
      }
    } catch (error) {
      if (headless || error instanceof AgentLaunchError) throw error;
      // Installed-version failures must still permit ordinary interactive use.
      this.nativeSync = 'fallback';
    }
    this.publish();
    return {
      ...this.launch.main,
      file: this.resource?.binary ?? this.adapter.binary,
      args: this.resource?.args ?? args,
      cwd: opts.worktreePath,
      env: { ...env, PUDDLE_AGENT_SIGNAL_URL: signalUrl, PUDDLE_AGENT_SIGNAL_NONCE: this.nonce },
    };
  }

  state(): RuntimeAgentState {
    return runtimeAgentStateSchema.parse({
      provider: this.adapter.id,
      native_sync: this.nativeSync,
      status: this.status,
      agent_session_ref: this.ref,
      control_ready:
        !this.closed && !this.lifecycleUnavailable && (this.resource?.control?.ready ?? false),
      sidecar_pids: this.closed ? [] : (this.resource?.sidecarPids ?? []),
      hidden_ports: this.closed
        ? []
        : [...(this.resource?.hiddenPorts ?? []), ...(this.signalPort ? [this.signalPort] : [])],
    });
  }

  output(data: string): void {
    if (!this.closed) this.detector.feed(data);
  }
  control(): AgentControl | null {
    return this.closed || this.lifecycleUnavailable ? null : (this.resource?.control ?? null);
  }
  humanInput(): void {
    if (!this.closed) this.resource?.control?.input?.();
  }

  private receive(signal: AgentSignalRequest): boolean {
    if (this.closed) return false;
    if ('state' in signal) {
      this.signalStatus(signal.state);
      return true;
    }
    if ('turn_id' in signal) {
      const state = this.resource?.control?.signal?.(signal);
      if (state) this.signalStatus(state);
      return this.resource?.control?.signal !== undefined;
    }
    const parsed = runtimeLifecycleSchema.safeParse(signal);
    if (!parsed.success) return false;
    const lifecycle = parsed.data;
    // Hooks from the previous conversation may finish after a native switch.
    if (
      lifecycle.event === 'session_end' &&
      lifecycle.agent_session_ref !== undefined &&
      lifecycle.agent_session_ref !== this.ref
    )
      return true;
    if (lifecycle.event === 'session_start' && lifecycle.agent_session_ref !== this.ref) {
      const ref = lifecycle.agent_session_ref!;
      if (!this.claim.switch(ref)) {
        this.observers.collision(ref);
        return false;
      }
      this.ref = ref;
    }
    this.resource?.control?.lifecycle?.(
      lifecycle.agent_session_ref,
      lifecycle.event === 'session_end',
    );
    this.observers.lifecycle(lifecycle);
    this.publish();
    return true;
  }

  private signalStatus(state: 'working' | 'waiting_input'): void {
    if (this.closed) return;
    this.signalled = true;
    this.setStatus(state === 'working' ? 'running' : 'waiting_input');
  }
  private setStatus(status: RuntimeAgentState['status']): void {
    if (this.closed || this.status === status) return;
    this.status = status;
    this.publish();
  }
  private publish(): void {
    if (!this.closed) this.observers.state(this.state());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.status = 'exited';
    this.detector.dispose();
    try {
      await this.signals.close();
      await this.resource?.dispose();
    } finally {
      this.claim.close();
    }
  }
}
