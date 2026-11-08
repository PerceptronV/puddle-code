import { randomUUID } from 'node:crypto';
import {
  desktopWindowCommandReplySchema,
  desktopWindowCommandSchema,
  type DesktopWindowCommand,
  type DesktopPaneFocus,
  type DesktopContentMoveCommand,
  type DesktopProjectCommand,
  type DesktopWindowTransferCommand,
  type DesktopWorkspaceVersion,
  type DesktopArrangementCommand,
  type DesktopArrangementPlanCommand,
  type DesktopArrangementPlan,
  type DesktopWindowCommandReply,
} from '@puddle/shared';

interface Pending {
  windowId: string;
  resolve(reply: DesktopWindowCommandReply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounded, correlated commands to a registered renderer, never arbitrary page code. */
export class WindowCommands {
  private readonly renderers = new Map<string, (command: DesktopWindowCommand) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly generations = new Map<string, number>();
  private readonly waiting = new Map<string, Set<() => void>>();

  constructor(private readonly timeoutMs = 10_000) {}

  ready(windowId: string, send: (command: DesktopWindowCommand) => void): void {
    this.disconnected(windowId);
    this.generations.set(windowId, (this.generations.get(windowId) ?? 0) + 1);
    this.renderers.set(windowId, send);
    for (const ready of this.waiting.get(windowId) ?? []) ready();
  }

  available(windowId: string): boolean {
    return this.renderers.has(windowId);
  }

  generation(windowId: string): number | null {
    return this.available(windowId) ? this.generations.get(windowId)! : null;
  }

  whenReady(windowId: string): Promise<void> {
    if (this.available(windowId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = this.waiting.get(windowId) ?? new Set();
      this.waiting.set(windowId, waiters);
      const remove = () => {
        waiters.delete(ready);
        if (!waiters.size) this.waiting.delete(windowId);
      };
      const timer = setTimeout(() => {
        remove();
        reject(new Error('The new window did not finish loading'));
      }, this.timeoutMs);
      const ready = () => {
        clearTimeout(timer);
        remove();
        resolve();
      };
      waiters.add(ready);
    });
  }

  request(
    windowId: string,
    kind: DesktopWindowCommand['kind'],
    payload?: DesktopPaneFocus,
  ): Promise<void> {
    return this.dispatch(windowId, { kind, ...payload }).then(() => undefined);
  }

  transfer(
    windowId: string,
    command: DesktopWindowTransferCommand,
  ): Promise<DesktopWorkspaceVersion | undefined> {
    return this.dispatch(windowId, command).then((reply) => reply.version);
  }

  arrangement(
    windowId: string,
    command: DesktopArrangementCommand,
  ): Promise<DesktopWorkspaceVersion | undefined> {
    return this.dispatch(windowId, command).then((reply) => reply.version);
  }

  planArrangement(
    windowId: string,
    command: DesktopArrangementPlanCommand,
  ): Promise<DesktopArrangementPlan | undefined> {
    return this.dispatch(windowId, command).then((reply) => reply.arrangement);
  }

  moveContent(windowId: string, command: DesktopContentMoveCommand): Promise<void> {
    return this.dispatch(windowId, command).then(() => undefined);
  }

  project(windowId: string, command: DesktopProjectCommand): Promise<void> {
    return this.dispatch(windowId, command).then(() => undefined);
  }

  private dispatch(windowId: string, command: unknown): Promise<DesktopWindowCommandReply> {
    const send = this.renderers.get(windowId);
    if (!send) return Promise.reject(new Error('Window renderer is unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Window did not finish saving; it has been left open'));
      }, this.timeoutMs);
      this.pending.set(id, { windowId, resolve, reject, timer });
      try {
        if (Buffer.byteLength(JSON.stringify(command)) > 16 * 1024 * 1024)
          throw new Error('Window command is too large');
        send(desktopWindowCommandSchema.parse({ ...(command as object), id }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  reply(windowId: string, value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
      throw new Error('Window reply is too large');
    const reply = desktopWindowCommandReplySchema.parse(value);
    const pending = this.pending.get(reply.id);
    // A late reply is observation only. A sibling cannot acknowledge the request.
    if (!pending) return;
    if (pending.windowId !== windowId) throw new Error('Window reply does not match');
    clearTimeout(pending.timer);
    this.pending.delete(reply.id);
    if (reply.error) pending.reject(new Error(reply.error));
    else pending.resolve(reply);
  }

  disconnected(windowId: string): void {
    this.renderers.delete(windowId);
    for (const [id, pending] of this.pending) {
      if (pending.windowId !== windowId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error('Window renderer disconnected before saving finished'));
    }
  }
}
