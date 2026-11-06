import { Component, createRef, type ReactNode } from 'react';
import { useReducedMotion } from '../../lib/appearance/motion';
import { cn } from '../../lib/utils';
import { placementMotionPending } from '../../lib/appearance/placement-motion';
import './overlay-motion.css';

interface Props {
  motionKey: string;
  children: ReactNode;
  className?: string;
  reduced: boolean;
  /** Replacing the contents of an already-open preview slot is quiet browsing. */
  preview?: boolean;
}

/**
 * Capture only at a content change, before React mutates the outgoing DOM.
 * The outgoing layer is inert paint, never a second editor/terminal instance.
 * This keeps navigation and persistence synchronous, including asynchronous
 * session creation and saved-layout restoration. No work runs between changes.
 */
class ContentMotionBoundary extends Component<Props> {
  private live = createRef<HTMLDivElement>();
  private layers = createRef<HTMLDivElement>();
  private animations: Animation[] = [];

  private clear = () => {
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
    this.layers.current?.replaceChildren();
  };

  getSnapshotBeforeUpdate(previous: Props): HTMLDivElement | null {
    if (
      previous.motionKey === this.props.motionKey ||
      (previous.preview && this.props.preview) ||
      this.props.reduced ||
      placementMotionPending()
    )
      return null;
    const live = this.live.current;
    if (!live || !live.getBoundingClientRect().width) return null;
    const snapshot = live.cloneNode(true) as HTMLDivElement;
    // Canvas pixels (xterm, PDF, notebook figures) are not included by cloneNode.
    const originals = live.querySelectorAll('canvas');
    snapshot.querySelectorAll('canvas').forEach((canvas, index) => {
      const original = originals[index];
      if (!original || !original.width || !original.height) return;
      try {
        canvas.getContext('2d')?.drawImage(original, 0, 0);
      } catch {
        // A transferred/offscreen canvas can still fade with its surrounding UI.
      }
    });
    snapshot.querySelectorAll('[data-motion-snapshot]').forEach((node) => node.remove());
    // Never mount a copied browsing context or restart media in the paint layer.
    snapshot
      .querySelectorAll('iframe, audio, video, object, embed')
      .forEach((node) => node.remove());
    // Copies must not participate in DOM identity, autofocus or drag targeting.
    for (const node of [snapshot, ...snapshot.querySelectorAll('*')]) {
      for (const name of node.getAttributeNames()) {
        if (name === 'id' || name === 'autofocus' || name.startsWith('data-'))
          node.removeAttribute(name);
      }
    }
    snapshot.inert = true;
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.dataset.motionSnapshot = '';
    const style = getComputedStyle(live);
    const bounds = live.getBoundingClientRect();
    snapshot.style.width = `${bounds.width}px`;
    snapshot.style.height = `${bounds.height}px`;
    snapshot.style.opacity = style.opacity;
    snapshot.style.scale = style.scale;
    return snapshot;
  }

  componentDidUpdate(previous: Props, _state: unknown, snapshot: HTMLDivElement | null) {
    if (
      this.props.reduced ||
      placementMotionPending() ||
      (previous.preview && this.props.preview && previous.motionKey !== this.props.motionKey)
    ) {
      this.clear();
      return;
    }
    if (previous.motionKey === this.props.motionKey) return;
    this.clear();
    const live = this.live.current;
    if (!live) return;
    // Same fade and gentle growth as overlay-appear / overlay-disappear.
    if (snapshot) {
      this.layers.current?.append(snapshot);
      this.animations.push(
        snapshot.animate(
          [
            { opacity: snapshot.style.opacity, scale: snapshot.style.scale },
            { opacity: 0, scale: '0.97' },
          ],
          { duration: 180, easing: 'ease-in', fill: 'forwards' },
        ),
      );
    }
    const entering = live.animate(
      [
        { opacity: 0, scale: '0.97' },
        { opacity: 1, scale: '1' },
      ],
      { duration: 180, easing: 'ease-out' },
    );
    this.animations.push(entering);
    void entering.finished.then(
      () => {
        if (this.animations.includes(entering)) this.clear();
      },
      () => {},
    );
  }

  componentWillUnmount() {
    this.clear();
  }

  render() {
    return (
      <div className={cn('relative min-h-0 min-w-0', this.props.className)} data-content-motion>
        <div ref={this.live} className="size-full min-h-0 min-w-0">
          {this.props.children}
        </div>
        <div
          ref={this.layers}
          className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
          inert
          aria-hidden="true"
        />
      </div>
    );
  }
}

export function ContentMotion(props: Omit<Props, 'reduced'>) {
  return <ContentMotionBoundary {...props} reduced={useReducedMotion()} />;
}
