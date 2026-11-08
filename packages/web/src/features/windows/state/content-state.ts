import type {
  DesktopBufferSnapshot,
  DesktopWorkspaceContent,
  LayoutNode,
  UiStateSnapshot,
  TabRef,
} from '@puddle/shared';
import { tabHoldsFile } from '@puddle/shared';
import type { WindowContentSource } from './working-set';

export function windowBufferKey(
  buffer: Pick<DesktopBufferSnapshot, 'session' | 'path' | 'root'>,
): string {
  return JSON.stringify([buffer.session, buffer.path, buffer.root ?? null]);
}

function referencedTabs(snapshot: UiStateSnapshot): TabRef[] {
  const refs: TabRef[] = [];
  const visit = (node: LayoutNode | null) => {
    if (!node) return;
    if (node.kind === 'split') node.children.forEach(visit);
    else refs.push(...node.tabs);
  };
  if (snapshot.layout_mode === 'project') {
    for (const slice of Object.values(snapshot.project_layouts)) visit(slice.layout_tree);
  } else visit(snapshot.layout_tree);
  return refs;
}

/**
 * Eager, Monaco-free capture seam. Editor/preview chunks register their existing
 * models and views; dormant or not-yet-loaded drafts remain recoverable here.
 */
export class DesktopContentState implements WindowContentSource {
  private epoch = 0;
  private buffers = new Map<string, DesktopBufferSnapshot>();
  private retained: readonly DesktopBufferSnapshot[] | null = null;
  private readonly readers = new Map<string, Set<() => DesktopBufferSnapshot | null>>();
  private views: Record<string, unknown> = {};
  private readonly listeners = new Set<() => void>();

  /** Stable cached text for recovery UI; never reads live editor models during rendering. */
  retainedBuffers = (): readonly DesktopBufferSnapshot[] =>
    (this.retained ??= [...this.buffers.values()]);

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }

  bufferChanged(identity: Pick<DesktopBufferSnapshot, 'session' | 'path' | 'root'>): void {
    const key = windowBufferKey(identity);
    const read = [...(this.readers.get(key) ?? [])].at(-1);
    if (!read) return;
    const value = read();
    if (value) this.buffers.set(key, value);
    else this.buffers.delete(key);
    this.retained = null;
    this.changed();
  }

  discardBuffer(identity: Pick<DesktopBufferSnapshot, 'session' | 'path' | 'root'>): void {
    const key = windowBufferKey(identity);
    this.buffers.delete(key);
    this.retained = null;
    this.readers.delete(key);
    this.changed();
  }

  buffer(
    identity: Pick<DesktopBufferSnapshot, 'session' | 'path' | 'root'>,
  ): DesktopBufferSnapshot | undefined {
    return this.buffers.get(windowBufferKey(identity));
  }

  registerBuffer(
    identity: Pick<DesktopBufferSnapshot, 'session' | 'path' | 'root'>,
    read: () => DesktopBufferSnapshot | null,
  ): () => void {
    const key = windowBufferKey(identity);
    const epoch = this.epoch;
    const readers = this.readers.get(key) ?? new Set<() => DesktopBufferSnapshot | null>();
    readers.add(read);
    this.readers.set(key, readers);
    return () => {
      if (!this.readers.get(key)?.has(read)) return;
      // Capture an inactive tab before its view disappears. A transfer adoption
      // advances the epoch so old source cleanup cannot reintroduce moved text.
      if (this.epoch === epoch) {
        const value = read();
        if (value) this.buffers.set(key, value);
        else this.buffers.delete(key);
        this.retained = null;
      }
      readers.delete(read);
      if (readers.size === 0) this.readers.delete(key);
    };
  }

  view<T>(key: string): T | undefined {
    // Opaque view payloads originate in the same renderer code. The owner bounds
    // their envelope; each view adapter handles absent or obsolete state.
    return this.views[key] as T | undefined;
  }

  setView(key: string, value: unknown): void {
    delete this.views[key];
    this.views[key] = value;
    const keys = Object.keys(this.views);
    for (const old of keys.slice(0, Math.max(0, keys.length - 500))) delete this.views[old];
    this.changed();
  }

  capture(snapshot?: UiStateSnapshot): Pick<DesktopWorkspaceContent, 'buffers' | 'views'> {
    const referenced = snapshot ? referencedTabs(snapshot) : null;
    const buffers = new Map(this.buffers);
    for (const [key, readers] of this.readers) {
      // React may not have disposed the source model yet after a transfer.
      // Never recapture a model whose tab has moved out of this working set.
      const value = [...readers].at(-1)?.() ?? null;
      // A null reader still clears a previously captured, now-clean draft.
      const identity = value ?? buffers.get(key);
      if (referenced && identity && !referenced.some((ref) => tabHoldsFile(ref, identity)))
        continue;
      if (value) buffers.set(key, value);
      else buffers.delete(key);
    }
    this.buffers = buffers;
    this.retained = null;
    return { buffers: [...buffers.values()], views: { ...this.views } };
  }

  restore(content: DesktopWorkspaceContent): void {
    this.epoch++;
    this.buffers = new Map(content.buffers.map((buffer) => [windowBufferKey(buffer), buffer]));
    this.retained = null;
    this.views = { ...content.views };
  }
}

const profiles = new Map<string, DesktopContentState>();
export function desktopContentState(profile: string): DesktopContentState {
  let state = profiles.get(profile);
  if (!state) {
    state = new DesktopContentState();
    profiles.set(profile, state);
  }
  return state;
}
