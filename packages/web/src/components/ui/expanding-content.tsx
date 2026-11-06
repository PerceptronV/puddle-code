import { Component, createRef, type ReactNode } from 'react';
import { useReducedMotion } from '../../lib/appearance/motion';
import { ContentMotion } from './content-motion';

interface Props {
  expanded: boolean;
  reduced: boolean;
  children: ReactNode;
}

/** Animate real height so following controls slide, including interrupted reversals. */
class Expansion extends Component<Props> {
  private element = createRef<HTMLDivElement>();
  private animation: Animation | null = null;

  getSnapshotBeforeUpdate(previous: Props): number | null {
    if (previous.expanded === this.props.expanded || this.props.reduced) return null;
    return this.element.current?.getBoundingClientRect().height ?? null;
  }

  componentDidUpdate(previous: Props, _state: unknown, height: number | null) {
    if (this.props.reduced) {
      this.animation?.cancel();
      this.animation = null;
      return;
    }
    if (previous.expanded === this.props.expanded) return;
    this.animation?.cancel();
    const element = this.element.current;
    if (!element || height === null) return;
    const target = element.getBoundingClientRect().height;
    if (height === target) return;
    const animation = element.animate(
      [
        { height: `${height}px`, overflow: 'clip' },
        { height: `${target}px`, overflow: 'clip' },
      ],
      { duration: 180, easing: 'ease-out' },
    );
    this.animation = animation;
    void animation.finished.then(
      () => {
        if (this.animation === animation) this.animation = null;
      },
      () => {},
    );
  }

  componentWillUnmount() {
    this.animation?.cancel();
  }

  render() {
    return (
      <div ref={this.element} data-expanding-content>
        <ContentMotion motionKey={String(this.props.expanded)}>{this.props.children}</ContentMotion>
      </div>
    );
  }
}

export function ExpandingContent(props: Omit<Props, 'reduced'>) {
  return <Expansion {...props} reduced={useReducedMotion()} />;
}
