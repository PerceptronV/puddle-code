export interface PreviewScrollTarget {
  session: string;
  path: string;
  root?: string;
}

export interface PreviewScrollPosition {
  ratio: number;
  revision: number;
}

type PreviewScrollListener = (position: PreviewScrollPosition) => void;

/** Clamp an arbitrary number to the proportional-scroll range. */
export function clampScrollRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/** Normalised vertical progress for DOM and Monaco scroll surfaces. */
export function normalisedScrollRatio(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  return clampScrollRatio(scrollTop / Math.max(1, scrollHeight - viewportHeight));
}

/** Concrete scroll offset for a proportional position after any reflow. */
export function scrollTopForRatio(
  ratio: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  return clampScrollRatio(ratio) * Math.max(0, scrollHeight - viewportHeight);
}

function storeKey(channel: string, target: PreviewScrollTarget): string {
  // JSON encoding avoids delimiter collisions. `root` is deliberately present:
  // a worktree file and a rooted external file may share the same relative path.
  return JSON.stringify([channel, target.session, target.root ?? null, target.path]);
}

/**
 * Browser-local proportional-scroll state (SPEC §8). One module instance is
 * one browser window; `channel` further isolates the profile-wide tree from
 * every project-local tree in that window. Nothing here persists or crosses
 * the daemon protocol.
 */
export class PreviewScrollStore {
  private readonly positions = new Map<string, PreviewScrollPosition>();
  private readonly listeners = new Map<string, Set<PreviewScrollListener>>();
  private revision = 0;

  publish(channel: string, target: PreviewScrollTarget, ratio: number): PreviewScrollPosition {
    const position = { ratio: clampScrollRatio(ratio), revision: ++this.revision };
    const key = storeKey(channel, target);
    this.positions.set(key, position);
    for (const listener of this.listeners.get(key) ?? []) listener(position);
    return position;
  }

  get(channel: string, target: PreviewScrollTarget): PreviewScrollPosition | undefined {
    return this.positions.get(storeKey(channel, target));
  }

  /** Subscribe to one target and replay only that target's latest value. */
  subscribe(
    channel: string,
    target: PreviewScrollTarget,
    listener: PreviewScrollListener,
  ): () => void {
    const key = storeKey(channel, target);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    const current = this.positions.get(key);
    if (current) listener(current);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.listeners.delete(key);
    };
  }
}

export const previewScrollStore = new PreviewScrollStore();

export interface AnimationFramePublisher {
  schedule(): void;
  dispose(): void;
}

/** Coalesce any number of measurements into the last callback of one frame. */
export function createAnimationFramePublisher(publish: () => void): AnimationFramePublisher {
  let frame: number | null = null;
  return {
    schedule: () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        publish();
      });
    },
    dispose: () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

interface ScrollElement {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(
    type: 'scroll',
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: 'scroll', listener: EventListener): void;
}

export interface PreviewScrollBinding {
  channel: string;
  target: PreviewScrollTarget;
  driver: boolean;
  receiver: boolean;
  /** Observe the outer viewport and inner content so delayed reflow reapplies. */
  resizeElements?: Element[];
  store?: PreviewScrollStore;
}

/**
 * Bind a Markdown-like DOM scroller. Drivers publish at most once per frame;
 * receivers never listen to their own scroll and therefore cannot feed back.
 */
export function bindPreviewScrollElement(
  element: ScrollElement,
  binding: PreviewScrollBinding,
): () => void {
  if (binding.driver && binding.receiver) {
    throw new Error('a preview scroll surface cannot be both driver and receiver');
  }
  const store = binding.store ?? previewScrollStore;
  let current: PreviewScrollPosition | undefined;
  let unsubscribe: () => void = () => undefined;
  let frames: AnimationFramePublisher | undefined;

  const apply = (position: PreviewScrollPosition) => {
    current = position;
    element.scrollTop = scrollTopForRatio(
      position.ratio,
      element.scrollHeight,
      element.clientHeight,
    );
  };

  if (binding.receiver) {
    // Subscribe before applying: subscribe's replay belongs only to this exact
    // target, so a retarget with no publisher waits instead of reusing old state.
    unsubscribe = store.subscribe(binding.channel, binding.target, apply);
  } else if (binding.driver) {
    frames = createAnimationFramePublisher(() => {
      store.publish(
        binding.channel,
        binding.target,
        normalisedScrollRatio(element.scrollTop, element.scrollHeight, element.clientHeight),
      );
    });
    element.addEventListener('scroll', frames.schedule, { passive: true });
    frames.schedule();
  }

  const observer = new ResizeObserver(() => {
    if (binding.receiver && current) apply(current);
    else if (binding.driver) frames?.schedule();
  });
  for (const resized of binding.resizeElements ?? []) observer.observe(resized);

  return () => {
    if (binding.driver && frames) element.removeEventListener('scroll', frames.schedule);
    unsubscribe();
    observer.disconnect();
    frames?.dispose();
  };
}
