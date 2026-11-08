import type {
  DesktopArrangementApplyRequest,
  DesktopArrangementObservation,
  DesktopWindowLayoutsBridge,
} from '@puddle/shared';

/** Lives outside React: staging replaces the popover which initiated the load. */
export class CatalogueApplication {
  private running = false;
  private uncertain: { id: string; profileId: string } | null = null;
  private readonly listeners = new Set<() => void>();
  busy = () => this.running;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async apply(
    bridge: DesktopWindowLayoutsBridge,
    request: DesktopArrangementApplyRequest,
  ): Promise<DesktopArrangementObservation> {
    if (!bridge.apply || !bridge.observe)
      throw new Error('Update the desktop app to load window layouts');
    if (this.running) throw new Error('A window layout is already loading');
    this.running = true;
    this.listeners.forEach((listener) => listener());
    try {
      if (this.uncertain) {
        const previous = await bridge.observe(this.uncertain);
        if (previous.status !== 'committed' && previous.status !== 'cancelled')
          throw new Error(
            'The previous layout outcome is still unknown. Reopen the host window to recover before loading another layout.',
          );
        this.uncertain = null;
        // An explicit second click observes the old operation; it never dispatches another load.
        throw new Error(
          `The previous layout was ${previous.status}. Choose the desired layout again to load it.`,
        );
      }
      this.uncertain = { id: request.id, profileId: request.profileId };
      let result: DesktopArrangementObservation;
      try {
        result = await bridge.apply(request);
      } catch {
        result = await bridge.observe(this.uncertain);
      }
      if (result.status === 'committed' || result.status === 'cancelled') this.uncertain = null;
      return result;
    } finally {
      this.running = false;
      this.listeners.forEach((listener) => listener());
    }
  }
}
