import { z } from 'zod';

/** Private daemon ↔ runtime contract, independent of the application and remote protocols. */
export const RUNTIME_PROTOCOL_VERSION = { major: 1, minor: 1 } as const;

export const RUNTIME_LIMITS = {
  frameBytes: 8 * 1024 * 1024,
  inputBytes: 64 * 1024,
  outputBytes: 256 * 1024,
  pendingRequests: 64,
  queuedBytes: 16 * 1024 * 1024,
  requestMs: 15_000,
  handshakeMs: 5_000,
  terminals: 32,
  journalEvents: 4096,
  journalBytes: 2 * 1024 * 1024,
  eventPage: 256,
  turnPromptBytes: 64 * 1024,
  turnReplyBytes: 256 * 1024,
  environmentVariables: 128,
  environmentValueBytes: 32 * 1024,
  historySegments: 256,
  historyLogBytes: 64 * 1024 * 1024,
  historyLogFiles: 1024,
  historySnapshotBytes: 64 * 1024 * 1024,
  pendingCheckpoints: 64,
  pendingCheckpointBytes: 16 * 1024 * 1024,
  launchRefs: 16_384,
} as const;

const id = z.uuid();
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(4096);
const path = text.refine(
  (value) => value.startsWith('/') && !value.includes('\0'),
  'Absolute host path required',
);
const protocol = z.object({ major: sequence, minor: sequence });
const terminalName = z.string().regex(/^(agent|shell-[1-9][0-9]{0,5})$/);
const size = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) };
const environmentName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(256);
const environmentValue = z
  .string()
  .max(RUNTIME_LIMITS.environmentValueBytes)
  .refine(
    (value) =>
      !value.includes('\0') &&
      new TextEncoder().encode(value).length <= RUNTIME_LIMITS.environmentValueBytes,
  );
export const runtimeEnvDeltaSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('unset'), name: environmentName }),
  z.object({
    op: z.literal('set'),
    name: environmentName,
    value: environmentValue,
  }),
]);
export type RuntimeEnvDelta = z.infer<typeof runtimeEnvDeltaSchema>;

/** Private launch seed; the runtime caches reports while puddled remains the application DB writer. */
export const runtimeCaptureSchema = z.object({
  enabled: z.boolean(),
  values: z
    .record(environmentName, environmentValue)
    .refine((values) => Object.keys(values).length <= RUNTIME_LIMITS.environmentVariables),
});
export const runtimeEnvironmentStateSchema = z.object({
  enabled: z.boolean(),
  count: z.number().int().min(0).max(RUNTIME_LIMITS.environmentVariables),
});

/** Separate from REST models so application changes cannot silently change this contract. */
export const runtimeIdentitySchema = z.object({
  runtime_id: id,
  incarnation: id,
  launch_id: id,
  profile_id: z.string().regex(/^[a-f0-9]{10}$/),
  project_id: z.string().regex(/^[a-f0-9]{10}$/),
  session_id: id,
  canonical_worktree_path: path,
});
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;

export const runtimeTerminalSchema = z.object({
  term: terminalName,
  generation: id,
  pid: z.number().int().positive().nullable(),
  exit_code: z.number().int().nullable(),
  ...size,
});
export type RuntimeTerminal = z.infer<typeof runtimeTerminalSchema>;

export const runtimeThemeSchema = z.object({
  fg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export type RuntimeTheme = z.infer<typeof runtimeThemeSchema>;

/** One current attention condition, not a replayable history of alerts. */
export const runtimeAttentionSchema = z.object({
  id,
  segment_id: id,
  reason: z.enum(['waiting_input', 'exited']),
  created_at: z.iso.datetime().max(32),
});
export type RuntimeAttention = z.infer<typeof runtimeAttentionSchema>;

export const runtimeSegmentSchema = z.object({
  id,
  start_cursor: sequence,
  agent_session_ref: z.string().min(1).max(200).nullable(),
});
export type RuntimeSegment = z.infer<typeof runtimeSegmentSchema>;

/** A mutation names the placement that the caller actually resolved, never a moving alias. */
export const runtimePlacementSchema = z.object({ segment_id: id, session_id: id });
export type RuntimePlacement = z.infer<typeof runtimePlacementSchema>;
export const runtimePlacementBindingSchema = runtimePlacementSchema.extend({ through: sequence });
export type RuntimePlacementBinding = z.infer<typeof runtimePlacementBindingSchema>;
export const runtimeCheckpointSchema = z
  .object({
    format: z.literal(1),
    identity: runtimeIdentitySchema,
    segment: runtimeSegmentSchema,
    through: sequence,
    terminal: runtimeTerminalSchema,
    data: z.string().max(RUNTIME_LIMITS.frameBytes),
  })
  .refine((value) => value.through >= value.segment.start_cursor);
export type RuntimeCheckpoint = z.infer<typeof runtimeCheckpointSchema>;

export const runtimeCommandSchema = z.object({
  file: text.min(1).refine((value) => !value.includes('\0')),
  args: z
    .array(
      z
        .string()
        .max(64 * 1024)
        .refine((value) => !value.includes('\0')),
    )
    .max(512),
  cwd: path,
  env: z
    .record(
      z
        .string()
        .regex(/^[^=\0]+$/)
        .max(256),
      z
        .string()
        .max(64 * 1024)
        .refine((value) => !value.includes('\0')),
    )
    .refine((value) => Object.keys(value).length <= 512, 'Too many environment variables'),
  ...size,
});
export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;

export const runtimeProviderLaunchSchema = z
  .object({
    id: z.string().min(1).max(64),
    config_dir: path,
    mode: z.enum(['interactive', 'headless']),
    skip_permissions: z.boolean(),
    prompt: z
      .string()
      .max(64 * 1024)
      .optional(),
    resume_ref: z.string().min(1).max(200).optional(),
    /** Exact adapter-declared id passed on a new preset-id launch, not a resume. */
    initial_ref: z.string().min(1).max(200).optional(),
    /** Existing native ids before a minted-id launch; recovery must exclude them. */
    prior_refs: z.array(z.string().min(1).max(200)).max(RUNTIME_LIMITS.launchRefs).optional(),
  })
  .refine(
    (value) => !(value.resume_ref && (value.initial_ref || value.prior_refs)),
    'A resume cannot carry new-launch identity evidence',
  );
export type RuntimeProviderLaunch = z.infer<typeof runtimeProviderLaunchSchema>;

/** Exact provider observations, with no nonce or application placement object. */
export const runtimeLifecycleSchema = z
  .object({
    event: z.enum(['session_start', 'session_end']),
    agent_session_ref: z.string().min(1).max(200).optional(),
    cwd: path,
    source: z.enum(['startup', 'resume', 'clear', 'fork', 'compact', 'exit', 'other']),
    parent_agent_session_ref: z.string().min(1).max(200).optional(),
    native_title: z.string().max(4096).optional(),
    native_created_at: z.iso.datetime({ offset: true }).optional(),
    native_updated_at: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(
    (value) => value.event !== 'session_start' || value.agent_session_ref !== undefined,
    'A native start requires an exact conversation ref',
  );
export type RuntimeLifecycle = z.infer<typeof runtimeLifecycleSchema>;

export const runtimeAgentStateSchema = z.object({
  provider: z.string().min(1).max(64),
  native_sync: z.enum(['full', 'fallback']),
  status: z.enum(['starting', 'running', 'waiting_input', 'exited']),
  agent_session_ref: z.string().min(1).max(200).nullable(),
  control_ready: z.boolean(),
  sidecar_pids: z.array(z.number().int().positive()).max(32),
  hidden_ports: z.array(z.number().int().min(1).max(65535)).max(64),
});
export type RuntimeAgentState = z.infer<typeof runtimeAgentStateSchema>;

export const runtimeTurnSchema = z.object({
  turn: sequence.refine((value) => value > 0),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  /** Native identity at admission; a new headless conversation may initially have none. */
  expected_ref: z.string().min(1).max(200).nullable(),
});
export type RuntimeTurn = z.infer<typeof runtimeTurnSchema>;

export const runtimeTurnResultSchema = runtimeTurnSchema
  .extend({
    reply: z
      .string()
      .max(RUNTIME_LIMITS.turnReplyBytes)
      .refine((value) => new TextEncoder().encode(value).length <= RUNTIME_LIMITS.turnReplyBytes)
      .optional(),
    error: z.string().max(4096).optional(),
  })
  .refine(
    (value) =>
      value.status === 'completed'
        ? value.reply !== undefined && value.error === undefined
        : value.reply === undefined &&
          (value.status === 'running' ? value.error === undefined : value.error !== undefined),
    'Turn outcome fields do not match its status',
  );
export type RuntimeTurnResult = z.infer<typeof runtimeTurnResultSchema>;

/** Essential observations are retained separately from disposable terminal output. */
export const runtimeRetainedEventSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('env-delta'),
    cursor: sequence,
    term: terminalName,
    generation: id,
    delta: runtimeEnvDeltaSchema,
  }),
  z.object({
    t: z.literal('cwd'),
    cursor: sequence,
    term: terminalName,
    generation: id,
    cwd: path,
  }),
  z.object({ t: z.literal('capture-env'), cursor: sequence, enabled: z.boolean() }),
  z.object({ t: z.literal('clear-env'), cursor: sequence }),
  z.object({
    t: z.literal('turn-started'),
    cursor: sequence,
    turn: runtimeTurnSchema.extend({ status: z.literal('running') }),
  }),
  z.object({
    t: z.literal('turn-finished'),
    cursor: sequence,
    result: runtimeTurnResultSchema.refine(
      (value) => value.status !== 'running',
      'Turn has not finished',
    ),
  }),
  z.object({
    t: z.literal('native-lifecycle'),
    cursor: sequence,
    lifecycle: runtimeLifecycleSchema,
    segment: runtimeSegmentSchema,
    previous_segment_id: id.nullable(),
  }),
  z.object({
    t: z.literal('native-collision'),
    cursor: sequence,
    agent_session_ref: z.string().min(1).max(200),
  }),
  z.object({ t: z.literal('terminal-created'), cursor: sequence, terminal: runtimeTerminalSchema }),
  z.object({
    t: z.literal('osc-title'),
    cursor: sequence,
    term: z.literal('agent'),
    generation: id,
    segment_id: id,
    title: z.string().min(1).max(80),
  }),
  z.object({
    t: z.literal('exit'),
    cursor: sequence,
    term: terminalName,
    generation: id,
    exit_code: z.number().int(),
  }),
]);
export type RuntimeRetainedEvent = z.infer<typeof runtimeRetainedEventSchema>;

export const runtimeJournalStatusSchema = z.object({
  cursor: sequence,
  acknowledged: sequence,
  lost_through: sequence,
  persistence_pending: z.boolean(),
});

export const runtimeEventPageSchema = z.object({
  events: z.array(runtimeRetainedEventSchema).max(RUNTIME_LIMITS.eventPage),
  through: sequence,
  more: z.boolean(),
  gap: z.boolean(),
  journal: runtimeJournalStatusSchema,
});
export type RuntimeEventPage = z.infer<typeof runtimeEventPageSchema>;

export const runtimeStateSchema = z.object({
  identity: runtimeIdentitySchema,
  build: z.string().min(1).max(128),
  /** Process-group separation does not establish survival of host session teardown. */
  lifetime: z.enum(['service', 'host_session', 'unknown']).optional(),
  protocol,
  state: z.enum(['prepared', 'running', 'exited', 'failed']),
  terminals: z.array(runtimeTerminalSchema).max(RUNTIME_LIMITS.terminals),
  event_cursor: sequence,
  command_cursor: sequence,
  persistence_pending: z.boolean(),
  journal: runtimeJournalStatusSchema,
  agent: runtimeAgentStateSchema.nullable(),
  turn: runtimeTurnSchema.nullable(),
  environment: runtimeEnvironmentStateSchema,
  /** Omitted by older experimental owners; null means no cockpit report yet. */
  theme: runtimeThemeSchema.nullable().optional(),
  attention: runtimeAttentionSchema.nullable().optional(),
  /** Transient foreground hint for a terminal placement; never a native binding. */
  terminal_agent: z.string().min(1).max(64).nullable().optional(),
  binding: runtimePlacementBindingSchema.nullable(),
  history: z.object({
    current: runtimeSegmentSchema,
    pending_checkpoints: z.number().int().min(0).max(RUNTIME_LIMITS.pendingCheckpoints),
    gap: z.boolean(),
  }),
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export const runtimeRequestSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    id,
    protocol,
    runtime_id: id,
    incarnation: id,
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    controller_id: id,
    controller_epoch: sequence,
  }),
  z.object({ t: z.literal('inspect'), id, sequence }),
  z.object({
    t: z.literal('attention-preview'),
    id,
    sequence,
    placement: runtimePlacementSchema,
    attention_id: id,
  }),
  z.object({
    t: z.literal('theme'),
    id,
    sequence,
    placement: runtimePlacementSchema,
    colours: runtimeThemeSchema,
  }),
  z.object({
    t: z.literal('bind-placement'),
    id,
    sequence,
    binding: runtimePlacementBindingSchema,
  }),
  z.object({
    t: z.literal('capture-env'),
    id,
    sequence,
    placement: runtimePlacementSchema,
    enabled: z.boolean(),
  }),
  z.object({ t: z.literal('clear-env'), id, sequence, placement: runtimePlacementSchema }),
  z.object({ t: z.literal('events'), id, sequence, after: sequence }),
  z.object({ t: z.literal('ack-events'), id, sequence, through: sequence }),
  z.object({
    t: z.literal('start-turn'),
    id,
    sequence,
    placement: runtimePlacementSchema,
    turn: runtimeTurnSchema.shape.turn,
    expected_ref: runtimeTurnSchema.shape.expected_ref,
    prompt: z
      .string()
      .min(1)
      .max(RUNTIME_LIMITS.turnPromptBytes)
      .refine((value) => new TextEncoder().encode(value).length <= RUNTIME_LIMITS.turnPromptBytes),
    output_schema: z
      .record(z.string().max(256), z.unknown())
      .refine(
        (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 64 * 1024,
        'Output schema exceeds its byte limit',
      )
      .optional(),
  }),
  z.object({ t: z.literal('turn-result'), id, sequence, turn: runtimeTurnSchema.shape.turn }),
  z.object({
    t: z.literal('cancel-turn'),
    id,
    sequence,
    placement: runtimePlacementSchema,
    turn: runtimeTurnSchema.shape.turn,
  }),
  z.object({ t: z.literal('snapshot'), id, sequence, term: terminalName, generation: id }),
  z.object({
    t: z.literal('segment-snapshot'),
    id,
    sequence,
    segment_id: id,
    term: terminalName,
    generation: id,
  }),
  z.object({
    t: z.literal('input'),
    id,
    sequence,
    placement: runtimePlacementSchema,
    term: terminalName,
    generation: id,
    data: z.string().max(RUNTIME_LIMITS.inputBytes),
    source: z.enum(['human', 'script']),
  }),
  z.object({
    t: z.literal('resize'),
    id,
    sequence,
    placement: runtimePlacementSchema,
    term: terminalName,
    generation: id,
    ...size,
  }),
  z.object({
    t: z.literal('spawn-shell'),
    id,
    sequence,
    placement: runtimePlacementSchema,
    term: terminalName.refine((value) => value !== 'agent'),
    command: runtimeCommandSchema,
  }),
  z.object({
    t: z.literal('kill-terminal'),
    id,
    sequence,
    placement: runtimePlacementSchema,
    term: terminalName,
    generation: id,
  }),
  z.object({ t: z.literal('stop'), id, sequence, placement: runtimePlacementSchema }),
]);
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

export const runtimeResponseSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('attention-preview'), id, attention_id: id, text: z.string().max(4096) }),
  z.object({ t: z.literal('state'), id, state: runtimeStateSchema }),
  z.object({ t: z.literal('ok'), id }),
  z.object({
    t: z.literal('env-cleared'),
    id,
    through: sequence,
    cleared: z.number().int().min(0).max(RUNTIME_LIMITS.environmentVariables),
  }),
  z.object({ t: z.literal('events'), id, page: runtimeEventPageSchema }),
  z.object({ t: z.literal('turn'), id, result: runtimeTurnResultSchema }),
  z.object({ t: z.literal('segment-snapshot'), id, checkpoint: runtimeCheckpointSchema }),
  z.object({
    t: z.literal('snapshot'),
    id,
    term: terminalName,
    generation: id,
    cursor: sequence,
    segment_id: id,
    data: z.string().max(RUNTIME_LIMITS.frameBytes),
  }),
  z.object({
    t: z.literal('error'),
    id,
    code: z.enum([
      'invalid_request',
      'incompatible',
      'unauthorised',
      'fenced',
      'busy',
      'stale_terminal',
      'stale_placement',
      'duplicate_request',
      'result_unavailable',
      'failed',
    ]),
    message: z.string().max(1024),
  }),
]);
export type RuntimeResponse = z.infer<typeof runtimeResponseSchema>;

export const runtimeEventSchema = z.discriminatedUnion('t', [
  ...runtimeRetainedEventSchema.options,
  z.object({
    t: z.literal('terminal-agent-state'),
    cursor: sequence,
    agent: z.string().min(1).max(64).nullable(),
  }),
  z.object({
    t: z.literal('attention-state'),
    cursor: sequence,
    attention: runtimeAttentionSchema.nullable(),
  }),
  z.object({ t: z.literal('agent-state'), cursor: sequence, agent: runtimeAgentStateSchema }),
  z.object({
    t: z.literal('output'),
    cursor: sequence,
    term: terminalName,
    generation: id,
    segment_id: id,
    data: z.string().max(RUNTIME_LIMITS.outputBytes),
  }),
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const runtimeMessageSchema = z.union([runtimeResponseSchema, runtimeEventSchema]);
export type RuntimeMessage = z.infer<typeof runtimeMessageSchema>;

const messageTypes = new Set([
  ...runtimeResponseSchema.options.map((schema) => schema.shape.t.value),
  ...runtimeEventSchema.options.map((schema) => schema.shape.t.value),
]);
const messageEnvelope = z.object({ t: z.string().min(1).max(64) });

/** Future additive event types are ignored; malformed known messages remain errors. */
export function parseRuntimeMessage(value: unknown): RuntimeMessage | null {
  const envelope = messageEnvelope.parse(value);
  if (!(messageTypes as ReadonlySet<string>).has(envelope.t)) return null;
  return runtimeMessageSchema.parse(value);
}

/** Compare protocol identity only; a newer additive minor remains compatible. */
export function compatibleRuntimeProtocol(peer: { major: number; minor: number }): boolean {
  return peer.major === RUNTIME_PROTOCOL_VERSION.major;
}
