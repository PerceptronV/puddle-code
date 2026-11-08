import { randomUUID } from 'node:crypto';
import {
  desktopWindowCommandReplySchema,
  desktopWindowCommandSchema,
  type DesktopWindowCommand,
  type DesktopPaneFocus,
  type DesktopWindowTransferCommand,
  type DesktopWorkspaceVersion,
} from '@puddle/shared';

interface Pending {
  windowId: string;
  resolve(version?: DesktopWorkspaceVersion): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounded, correlated commands to a registered renderer, never arbitrary page code. */
export class WindowCommands {
  private readonly renderers = new Map<string, (command: DesktopWindowCommand) => void>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 10_000) {}

  ready(windowId: string, send: (command: DesktopWindowCommand) => void): void {
    this.disconnected(windowId);
    this.renderers.set(windowId, send);
  }

  available(windowId: string): boolean {
    return this.renderers.has(windowId);
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
    return this.dispatch(windowId, command);
  }

  private dispatch(
    windowId: string,
    command: unknown,
  ): Promise<DesktopWorkspaceVersion | undefined> {
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
    else pending.resolve(reply.version);
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
