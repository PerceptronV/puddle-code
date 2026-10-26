import { randomUUID } from 'node:crypto';
import { mergeWidgetMessage } from '@puddle/shared';
import type {
  NotebookWidgetMessage,
  NotebookWidgetState,
  NotebookWidgetsRequest,
  NotebookWidgetsResponse,
} from '@puddle/shared';

const MAX_BYTES = 4 * 1024 * 1024;

/** Kernel-owned widget state outlives every execution and browser view. */
export class NotebookWidgets {
  readonly generation = randomUUID();
  private models: NotebookWidgetState['state'] = {};
  private events: { revision: number; message: NotebookWidgetMessage; bytes: number }[] = [];
  private revision = 0;
  private eventBytes = 0;
  private failure?: string;

  fail(error: string): void {
    this.failure = error.slice(0, 1024);
    this.events = [];
    this.eventBytes = 0;
    this.models = {};
    this.revision++;
  }

  has(id: string): boolean {
    return !this.failure && Object.hasOwn(this.models, id);
  }

  receive(message: NotebookWidgetMessage): void {
    if (this.failure) return;
    try {
      this.models = mergeWidgetMessage(this.models, message);
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (
        Object.keys(this.models).length > 1024 ||
        bytes > 2 * 1024 * 1024 ||
        Buffer.byteLength(JSON.stringify(this.models)) > MAX_BYTES
      ) {
        this.fail(
          'Widget state exceeded its size limit (1,024 models / 4 MiB). Restart the kernel to reset it.',
        );
        return;
      }
      this.events.push({ revision: ++this.revision, message, bytes });
      this.eventBytes += bytes;
      while (this.events.length > 256 || this.eventBytes > 2 * 1024 * 1024)
        this.eventBytes -= this.events.shift()!.bytes;
    } catch {
      this.fail('Invalid widget state received from the kernel');
    }
  }

  snapshot(request: Pick<NotebookWidgetsRequest, 'generation' | 'after'>): NotebookWidgetsResponse {
    const incremental =
      request.generation === this.generation &&
      request.after !== undefined &&
      request.after <= this.revision &&
      request.after >= (this.events[0]?.revision ?? this.revision + 1) - 1;
    return {
      generation: this.generation,
      revision: this.revision,
      ...(incremental
        ? {}
        : {
            snapshot: {
              version_major: 2,
              version_minor: 0,
              state: this.models,
            } as NotebookWidgetState,
          }),
      events: incremental
        ? this.events
            .filter((event) => event.revision > request.after!)
            .map((event) => event.message)
        : [],
      ...(this.failure ? { error: this.failure } : {}),
    };
  }
}
