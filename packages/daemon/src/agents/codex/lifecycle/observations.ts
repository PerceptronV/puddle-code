import type { RawData } from 'ws';
import type { LifecycleLaunchContext } from '../../adapter.js';
import type { RuntimeBufferBudget } from '../../../runtime/resources/budget.js';
import { CodexBridgeBudgets } from './limits.js';
import { CodexSignalQueue } from './signals.js';

export interface PendingRequest {
  release?: () => void;
  method: 'thread/start' | 'thread/resume' | 'thread/fork';
  cwd: string;
  parentRef?: string;
  requestedRef?: string;
  ephemeral: boolean;
}

export interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

export interface CodexSignalState {
  activeRef: string | null;
  queue: Promise<void>;
  delivery?: CodexSignalQueue;
}

function delivery(context: LifecycleLaunchContext, state: CodexSignalState): CodexSignalQueue {
  return (state.delivery ??= new CodexSignalQueue(
    context,
    new CodexBridgeBudgets(context.bufferAllowance).signals,
  ));
}

export function inspectRequest(
  messages: JsonRpcMessage[],
  pending: Map<string, PendingRequest>,
  defaultCwd: string,
  budget: RuntimeBufferBudget,
): boolean {
  const additions = new Map<string, PendingRequest>();
  try {
    for (const message of messages) {
      if (
        message.id === undefined ||
        !['thread/start', 'thread/resume', 'thread/fork'].includes(message.method ?? '')
      )
        continue;
      const id = String(message.id);
      const params = message.params ?? {};
      const method = message.method as PendingRequest['method'];
      const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : defaultCwd;
      const ref = typeof params['threadId'] === 'string' ? params['threadId'] : undefined;
      if (
        id.length > 4096 ||
        cwd.length > 4096 ||
        (ref !== undefined && ref.length > 200) ||
        pending.has(id) ||
        additions.has(id)
      )
        throw new Error('Invalid Codex lifecycle request identity');
      const release = budget.reserve(2 * (id.length + cwd.length + (ref?.length ?? 0)) + 512);
      if (!release) return false;
      additions.set(id, {
        method,
        cwd,
        release,
        ...(ref !== undefined
          ? method === 'thread/fork'
            ? { parentRef: ref }
            : { requestedRef: ref }
          : {}),
        ephemeral: params['ephemeral'] === true,
      });
    }
    for (const [id, entry] of additions) pending.set(id, entry);
    additions.clear();
    return true;
  } finally {
    clearPending(additions);
  }
}

export function clearPending(pending: Map<string, PendingRequest>): void {
  for (const entry of pending.values()) entry.release?.();
  pending.clear();
}

export function inspectResponse(
  data: RawData,
  pending: Map<string, PendingRequest>,
  context: LifecycleLaunchContext,
  state: CodexSignalState,
): void {
  inspectMessages(parseMessages(data), pending, context, state);
}

export function inspectMessages(
  messages: JsonRpcMessage[],
  pending: Map<string, PendingRequest>,
  context: LifecycleLaunchContext,
  state: CodexSignalState,
): boolean {
  const signals = delivery(context, state);
  const observed = new Map<string, PendingRequest>();
  const jobs: Array<{ body: string; essential: boolean }> = [];
  let active = state.activeRef;
  for (const message of messages) {
    if (message.id === undefined) {
      if (!active || message.params?.['threadId'] !== active) continue;
      const status =
        message.method === 'turn/started'
          ? 'working'
          : message.method === 'turn/completed'
            ? 'waiting_input'
            : null;
      if (status) {
        if (jobs.at(-1)?.essential === false) jobs.pop();
        jobs.push({
          body: JSON.stringify({ nonce: context.signalNonce, state: status }),
          essential: false,
        });
      }
      continue;
    }
    const id = String(message.id);
    const request = pending.get(id);
    if (!request || observed.has(id)) continue;
    observed.set(id, request);
    if (message.error !== undefined || request.ephemeral) continue;
    const thread = message.result?.['thread'];
    const record = thread && typeof thread === 'object' ? (thread as Record<string, unknown>) : {};
    if (record['ephemeral'] === true) continue;
    const ref = typeof record['id'] === 'string' ? record['id'] : request.requestedRef;
    if (!ref) continue;
    if (ref.length > 200 || request.cwd.length > 4096 || (request.parentRef?.length ?? 0) > 200) {
      signals.fail();
      continue;
    }
    const source =
      request.method === 'thread/fork'
        ? 'fork'
        : request.method === 'thread/resume'
          ? 'resume'
          : active === null
            ? 'startup'
            : 'clear';
    jobs.push({
      body: JSON.stringify({
        nonce: context.signalNonce,
        event: 'session_start',
        agent_session_ref: ref,
        cwd: request.cwd,
        source,
        ...(request.parentRef !== undefined ? { parent_agent_session_ref: request.parentRef } : {}),
      }),
      essential: true,
    });
    active = ref;
  }
  if (!signals.admit(jobs)) return false;
  for (const [id, request] of observed) {
    pending.delete(id);
    request.release?.();
  }
  state.activeRef = active;
  state.queue = signals.settled;
  return true;
}

export function parseMessages(data: RawData): JsonRpcMessage[] {
  try {
    const parsed = JSON.parse(rawBuffer(data).toString('utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : isRecord(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

export function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isRecord(value: unknown): value is JsonRpcMessage {
  return value !== null && typeof value === 'object';
}
